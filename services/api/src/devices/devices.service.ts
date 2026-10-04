import { HttpStatus, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { IdpError, IdpUsersService } from '../account/idp-users';
import { StructuredLogger } from '../common/logger';
import { writeAudit } from '../audit/audit';
import { ApiError } from '../common/api-error';
import { Database } from '../db/database';
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

/** A failed Keycloak session end is retried this often, for devices signed out in the last 30 days. */
const SESSION_RETRY_MS = 10 * 60 * 1000;

@Injectable()
export class DevicesService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Database,
    private readonly idp: IdpUsersService,
    private readonly logger: StructuredLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.retrySessionEnds().catch(() => undefined), SESSION_RETRY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Ends the Keycloak session of each recently signed-out device whose session end has not been confirmed. */
  async retrySessionEnds(): Promise<number> {
    const rows = await this.db.query<{ user_id: string; id: string; idp_session_id: string }>(
      `SELECT user_id, id, idp_session_id FROM devices
        WHERE revoked_at IS NOT NULL AND revoked_at > now() - interval '30 days' AND idp_session_id IS NOT NULL AND idp_session_ended_at IS NULL
        LIMIT 100`,
    );
    let ended = 0;
    for (const r of rows) if (await this.endIdpSession(r.user_id, r.id, r.idp_session_id)) ended++;
    return ended;
  }

  /** Best effort: the API already refuses the session, so a Keycloak failure is logged and retried later. */
  private async endIdpSession(ownerId: string, deviceId: string, sid: string): Promise<boolean> {
    try {
      if ((await this.idp.endSession(sid)) === 'not_configured') return false;
      await this.db.query('UPDATE devices SET idp_session_ended_at = now() WHERE user_id = $1 AND id = $2', [ownerId, deviceId]);
      return true;
    } catch (err) {
      this.logger.log('WARN', { eventCode: 'IDP_SESSION_END_FAILED', ...(err instanceof IdpError ? { errorCode: 'IDP_SESSION_FAILED', status: err.status } : { errorName: (err as Error)?.name }) });
      return false;
    }
  }

  /** `serverObservedAt` (Doc 17): the server's clock when the list was read, to compare last-seen times against. */
  async list(ownerId: string): Promise<{ settingsRevision: number; serverObservedAt: string; devices: DeviceView[] }> {
    const [devices, settings] = await Promise.all([
      this.db.query<Row>(`SELECT ${COLUMNS} FROM devices WHERE user_id = $1 ORDER BY revoked_at NULLS FIRST, last_seen_at DESC`, [ownerId]),
      this.db.query<{ revision: string }>('SELECT revision FROM account_preferences WHERE owner_id = $1', [ownerId]),
    ]);
    return { settingsRevision: Number(settings[0]?.revision ?? 0), serverObservedAt: new Date().toISOString(), devices: devices.map(toView) };
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
    const { view, sid } = await this.db.transaction(async (query) => {
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
      const [session] = await query<{ idp_session_id: string | null; idp_session_ended_at: Date | null }>('SELECT idp_session_id, idp_session_ended_at FROM devices WHERE user_id = $1 AND id = $2', [ownerId, deviceId]);
      return { view: toView(rows[0]), sid: session.idp_session_ended_at ? null : session.idp_session_id };
    });
    // After the commit: the API refuses the session from now on; Keycloak is told too, and retried if it fails.
    if (sid) await this.endIdpSession(ownerId, deviceId, sid);
    return view;
  }
}
