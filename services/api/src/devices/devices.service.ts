import { HttpStatus, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { allLimited } from '../common/concurrency';
import { IdpError, IdpUsersService } from '../account/idp-users';
import { StructuredLogger } from '../common/logger';
import { writeAudit } from '../audit/audit';
import { ApiError } from '../common/api-error';
import { encodeCursor, PAGE_MAX } from '../common/pagination';
import { Database } from '../db/database';
import { afterFailure, jobErrorCode, WORKER_TICK_MS } from '../jobs/retry-policy';
import { normalizeOverrides, Overrides } from './device-preferences';
import { DeviceReport, MAX_ACTIVE_DEVICES } from './devices.schema';

export interface DeviceView {
  id: string;
  platform: string;
  osMajor: number;
  appBuild: string;
  appliedSettingsRevision: number;
  /** Server-observed time of the device's last report; not a location or listening signal. */
  lastSeenAt: string;
  /** When the device last finished a sync push or pull; null if it never synced. */
  lastSyncedAt: string | null;
  revokedAt: string | null;
  /** Settings this device sets differently from the account (Doc 17 device_preferences); {} follows the account. */
  overrides: Overrides;
  /** The device's own preferences revision, 0 until first set. */
  preferencesRevision: number;
}

interface Row {
  id: string;
  platform: string;
  os_major: number;
  app_build: string;
  applied_settings_revision: string;
  last_seen_at: Date;
  last_synced_at: Date | null;
  revoked_at: Date | null;
  pref_value: unknown;
  pref_revision: string | null;
}

const COLUMNS = `id, platform, os_major, app_build, applied_settings_revision, last_seen_at, last_synced_at, revoked_at,
  (SELECT p.value FROM device_preferences p WHERE p.user_id = devices.user_id AND p.device_id = devices.id) AS pref_value,
  (SELECT p.revision FROM device_preferences p WHERE p.user_id = devices.user_id AND p.device_id = devices.id) AS pref_revision`;

const toView = (r: Row): DeviceView => ({
  id: r.id,
  platform: r.platform,
  osMajor: r.os_major,
  appBuild: r.app_build,
  appliedSettingsRevision: Number(r.applied_settings_revision),
  lastSeenAt: r.last_seen_at.toISOString(),
  lastSyncedAt: r.last_synced_at ? r.last_synced_at.toISOString() : null,
  revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
  overrides: normalizeOverrides(r.pref_value),
  preferencesRevision: Number(r.pref_revision ?? 0),
});

/**
 * A failed Keycloak session end backs off per the shared retry policy and is dead-lettered after 5 attempts
 * (shown on /admin/jobs, alerted). Only devices signed out in the last 30 days are worked on.
 */
export const SESSION_END_WINDOW_DAYS = 30;
/** A worker holds a due session end this long while it calls Keycloak, so instances do not double up. */
const SESSION_LEASE_MINUTES = 5;
/** Session ends taken per tick, and Keycloak calls in flight at once. */
const SESSION_END_BATCH = 25;
const SESSION_END_CONCURRENCY = 4;

/** What a session-end attempt left behind. */
export type SessionEndOutcome = 'ended' | 'retrying' | 'dead_letter' | 'not_configured';

@Injectable()
export class DevicesService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private working: Promise<number> | null = null;

  constructor(
    private readonly db: Database,
    private readonly idp: IdpUsersService,
    private readonly logger: StructuredLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      // A tick still calling Keycloak is left to finish; the next one starts after it.
      this.working ??= this.retrySessionEnds()
        .catch(() => 0)
        .finally(() => (this.working = null));
    }, WORKER_TICK_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.working;
  }

  /**
   * Ends the Keycloak session of each recently signed-out device whose session end is due and not yet confirmed.
   * A small batch, a few calls at a time, so the whole batch finishes well inside the lease it took.
   */
  async retrySessionEnds(): Promise<number> {
    const rows = await this.db.query<{ user_id: string; id: string; idp_session_id: string; idp_session_attempts: number }>(
      `UPDATE devices SET idp_session_next_attempt_at = now() + make_interval(mins => $2)
        WHERE (user_id, id) IN (
          SELECT user_id, id FROM devices
           WHERE revoked_at IS NOT NULL AND revoked_at > now() - make_interval(days => $1) AND idp_session_id IS NOT NULL
             AND idp_session_ended_at IS NULL AND idp_session_dead_at IS NULL
             AND (idp_session_next_attempt_at IS NULL OR idp_session_next_attempt_at <= now())
           LIMIT $3 FOR UPDATE SKIP LOCKED)
        RETURNING user_id, id, idp_session_id, idp_session_attempts`,
      [SESSION_END_WINDOW_DAYS, SESSION_LEASE_MINUTES, SESSION_END_BATCH],
    );
    const outcomes = await allLimited(
      rows.map((r) => () => this.endIdpSession(r.user_id, r.id, r.idp_session_id, r.idp_session_attempts)),
      SESSION_END_CONCURRENCY,
    );
    return outcomes.filter((o) => o === 'ended').length;
  }

  /**
   * Ends one signed-out device's Keycloak session now (staff "retry" on /admin/jobs). A dead-lettered one starts
   * a new round of attempts. Null when there is no open session end for that device.
   */
  async retrySessionEnd(ownerId: string, deviceId: string): Promise<SessionEndOutcome | null> {
    const [row] = await this.db.query<{ idp_session_id: string; idp_session_attempts: number }>(
      `UPDATE devices SET idp_session_dead_at = NULL, idp_session_next_attempt_at = NULL,
              idp_session_attempts = CASE WHEN idp_session_dead_at IS NOT NULL THEN 0 ELSE idp_session_attempts END
        WHERE user_id = $1 AND id = $2 AND revoked_at IS NOT NULL AND idp_session_id IS NOT NULL AND idp_session_ended_at IS NULL
        RETURNING idp_session_id, idp_session_attempts`,
      [ownerId, deviceId],
    );
    return row ? this.endIdpSession(ownerId, deviceId, row.idp_session_id, row.idp_session_attempts) : null;
  }

  /**
   * Best effort: the API already refuses the session, so a Keycloak failure is logged with its code and retried
   * later per the retry policy. Without a Keycloak admin client nothing is called and nothing is counted.
   */
  private async endIdpSession(ownerId: string, deviceId: string, sid: string, attemptsBefore: number): Promise<SessionEndOutcome> {
    try {
      if ((await this.idp.endSession(sid)) === 'not_configured') return 'not_configured';
      await this.db.query(
        `UPDATE devices SET idp_session_ended_at = now(), idp_session_last_attempt_at = now(), idp_session_next_attempt_at = NULL,
                idp_session_attempts = idp_session_attempts + 1
          WHERE user_id = $1 AND id = $2`,
        [ownerId, deviceId],
      );
      return 'ended';
    } catch (err) {
      const next = afterFailure(attemptsBefore);
      await this.db
        .query(
          `UPDATE devices SET idp_session_attempts = $3, idp_session_last_attempt_at = now(), idp_session_error_code = $4,
                  idp_session_next_attempt_at = now() + make_interval(secs => $5::int),
                  idp_session_dead_at = CASE WHEN $5::int IS NULL THEN now() END
            WHERE user_id = $1 AND id = $2 AND idp_session_ended_at IS NULL`,
          [ownerId, deviceId, next.attempts, jobErrorCode(err), next.retryInSeconds],
        )
        .catch(() => undefined);
      this.logger.log('WARN', {
        eventCode: next.retryInSeconds === null ? 'IDP_SESSION_END_DEAD_LETTERED' : 'IDP_SESSION_END_FAILED',
        ...(err instanceof IdpError ? { errorCode: 'IDP_SESSION_FAILED', status: err.status } : { errorName: (err as Error)?.name }),
      });
      return next.retryInSeconds === null ? 'dead_letter' : 'retrying';
    }
  }

  /** `serverObservedAt` (Doc 17): the server's clock when the list was read, to compare last-seen times against. */
  /** Active devices first, then most recently seen; one cursor page (Doc 17: 50 by default, at most 100). */
  async list(
    ownerId: string,
    after: string[] | null = null,
    limit = PAGE_MAX,
  ): Promise<{ settingsRevision: number; serverObservedAt: string; devices: DeviceView[]; nextCursor: string | null }> {
    const params: unknown[] = [ownerId, limit + 1];
    let where = '';
    if (after) {
      if (!/^[01]$/.test(after[0]) || Number.isNaN(Date.parse(after[1]))) throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field: 'cursor', reason: 'malformed' });
      params.push(Number(after[0]), after[1], after[2]);
      // Revoked flag ascending, last seen descending, id ascending.
      where = ` AND ((revoked_at IS NOT NULL)::int > $3 OR ((revoked_at IS NOT NULL)::int = $3 AND (date_trunc('milliseconds', last_seen_at) < $4::timestamptz
                 OR (date_trunc('milliseconds', last_seen_at) = $4::timestamptz AND id::text > $5))))`;
    }
    const [rows, settings] = await Promise.all([
      this.db.query<Row & { k_revoked: number; k_seen: Date }>(
        `SELECT ${COLUMNS}, (revoked_at IS NOT NULL)::int AS k_revoked, date_trunc('milliseconds', last_seen_at) AS k_seen FROM devices
          WHERE user_id = $1${where} ORDER BY k_revoked, k_seen DESC, id::text LIMIT $2`,
        params,
      ),
      this.db.query<{ revision: string }>('SELECT revision FROM account_preferences WHERE owner_id = $1', [ownerId]),
    ]);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      settingsRevision: Number(settings[0]?.revision ?? 0),
      serverObservedAt: new Date().toISOString(),
      devices: page.map(toView),
      nextCursor: rows.length > limit && last ? encodeCursor([String(last.k_revoked), last.k_seen.toISOString(), last.id]) : null,
    };
  }

  /**
   * Registers a device or records a check-in from it. A device cannot claim to
   * have applied a settings revision the server has not issued, and a revoked
   * device stays revoked until the user signs in on it again as a new device id.
   */
  async report(ownerId: string, deviceId: string, report: DeviceReport, sid?: string): Promise<DeviceView> {
    const current = await this.db.query<{ revision: string }>('SELECT revision FROM account_preferences WHERE owner_id = $1', [ownerId]);
    const settingsRevision = Number(current[0]?.revision ?? 0);
    if (report.appliedSettingsRevision > settingsRevision) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', {
        field: 'appliedSettingsRevision',
        reason: 'ahead_of_server',
        settingsRevision,
      });
    }
    // Serialize registrations per account so concurrent first check-ins cannot exceed the device cap.
    const rows = await this.db.transaction(async (query) => {
      await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`devices:${ownerId}`]);
      const existing = await query<Row>(`SELECT ${COLUMNS} FROM devices WHERE user_id = $1 AND id = $2`, [ownerId, deviceId]);
      if (existing[0]?.revoked_at) throw new ApiError(HttpStatus.FORBIDDEN, 'DEVICE_REVOKED');
      if (!existing[0]) {
        const active = await query<{ n: string }>('SELECT count(*) AS n FROM devices WHERE user_id = $1 AND revoked_at IS NULL', [ownerId]);
        if (Number(active[0].n) >= MAX_ACTIVE_DEVICES) {
          throw new ApiError(HttpStatus.CONFLICT, 'DEVICE_LIMIT', { maxActiveDevices: MAX_ACTIVE_DEVICES });
        }
      }
      return query<Row>(
        `INSERT INTO devices (user_id, id, platform, os_major, app_build, applied_settings_revision, idp_session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, id) DO UPDATE SET
           platform = EXCLUDED.platform,
           os_major = EXCLUDED.os_major,
           app_build = EXCLUDED.app_build,
           -- an older report arriving late never moves the applied revision backwards
           applied_settings_revision = GREATEST(devices.applied_settings_revision, EXCLUDED.applied_settings_revision),
           last_seen_at = now(),
           idp_session_id = COALESCE(EXCLUDED.idp_session_id, devices.idp_session_id)
         WHERE devices.revoked_at IS NULL
         RETURNING ${COLUMNS}`,
        [ownerId, deviceId, report.platform, report.osMajor, report.appBuild, report.appliedSettingsRevision, sid ?? null],
      );
    });
    // Revoked between the check and the write.
    if (!rows[0]) throw new ApiError(HttpStatus.FORBIDDEN, 'DEVICE_REVOKED');
    return toView(rows[0]);
  }

  /**
   * Revokes one of the owner's devices. Unknown ids and other users' ids look the same: 404.
   * The first revoke is audited in the same transaction; repeating it changes nothing and writes nothing.
   */
  async revoke(ownerId: string, deviceId: string, requestId?: string): Promise<DeviceView> {
    const { view, sid, attempts } = await this.db.transaction(async (query) => {
      const before = await query<{ revoked_at: Date | null }>('SELECT revoked_at FROM devices WHERE user_id = $1 AND id = $2 FOR UPDATE', [ownerId, deviceId]);
      if (!before[0]) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      const rows = await query<Row>(
        `UPDATE devices SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
        [ownerId, deviceId],
      );
      if (!before[0].revoked_at) {
        await writeAudit(query, {
          actor: `user:${ownerId}`,
          action: 'device.revoke',
          targetType: 'device',
          targetId: deviceId,
          changes: { platform: rows[0].platform },
          requestId,
        });
      }
      const [session] = await query<{ idp_session_id: string | null; idp_session_ended_at: Date | null; idp_session_dead_at: Date | null; idp_session_attempts: number }>(
        'SELECT idp_session_id, idp_session_ended_at, idp_session_dead_at, idp_session_attempts FROM devices WHERE user_id = $1 AND id = $2',
        [ownerId, deviceId],
      );
      // A dead-lettered session end waits for an operator; revoking again does not start a new round.
      const open = !session.idp_session_ended_at && !session.idp_session_dead_at;
      return { view: toView(rows[0]), sid: open ? session.idp_session_id : null, attempts: session.idp_session_attempts };
    });
    // After the commit: the API refuses the session from now on; Keycloak is told too, and retried if it fails.
    if (sid) await this.endIdpSession(ownerId, deviceId, sid, attempts);
    return view;
  }
}
