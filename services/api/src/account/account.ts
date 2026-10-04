import { createHash, randomBytes } from 'node:crypto';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { writeAudit } from '../audit/audit';
import { AuthGuard } from '../auth/auth.guard';
import { requireRecentSignIn } from '../auth/recent-sign-in';
import { ApiError } from '../common/api-error';
import { StructuredLogger } from '../common/logger';
import { Database, PG_POOL } from '../db/database';
import { DevicesService } from '../devices/devices.service';
import { SettingsService } from '../settings/settings.service';
import { subjectHash } from '../users/users.service';

/** Doc 17: the purge must finish within 30 days; failed attempts are retried on this cadence until it does. */
export const DELETION_DEADLINE_DAYS = 30;
const RETRY_EVERY_MS = 10 * 60_000;
/** Ticket rows are kept a little past the deadline so a user can still read "completed". */
const TICKET_KEEP_DAYS = 35;
/** Doc 17: exports hold at most 10k rows. */
const EXPORT_MAX_EVENTS = 10_000;
/** Fixed key so only one API instance works the deletion queue at a time. */
const LOCK_KEY = 7_421_018;

export type DeletionStatus = 'deleting' | 'completed' | 'failed';

const hashTicket = (ticket: string) => createHash('sha256').update(ticket).digest('hex');
const TICKET = /^[A-Za-z0-9_-]{43}$/;

@Injectable()
export class AccountService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private working: Promise<number> | null = null;
  private stopped = false;

  constructor(
    private readonly db: Database,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly settings: SettingsService,
    private readonly devices: DevicesService,
    private readonly logger: StructuredLogger,
  ) {}

  onApplicationBootstrap(): void {
    // Picks up requests a crashed or restarted instance left behind, and retries failures.
    this.timer = setInterval(() => void this.processQueue().catch(() => undefined), RETRY_EVERY_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.working?.catch(() => undefined);
  }

  async me(userId: string): Promise<{ userId: string; email: string | null; status: string; createdAt: string }> {
    const [u] = await this.db.query<{ id: string; email: string | null; status: string; created_at: Date }>('SELECT id, email, status, created_at FROM users WHERE id = $1', [userId]);
    return { userId: u.id, email: u.email, status: u.status, createdAt: u.created_at.toISOString() };
  }

  /** Everything the service holds about the account, as one JSON document. Built on request; nothing is stored. */
  async export(userId: string, requestId?: string) {
    const [account] = await this.db.query<{ id: string; created_at: Date; locale: string | null; email: string | null }>(
      'SELECT id, created_at, locale, email FROM users WHERE id = $1',
      [userId],
    );
    const [settings, devices, roles, reports, events] = await Promise.all([
      this.settings.get(userId),
      this.devices.list(userId),
      this.db.query<{ role: string; granted_at: Date; revoked_at: Date | null }>(
        'SELECT role, granted_at, revoked_at FROM staff_roles WHERE user_id = $1 ORDER BY granted_at',
        [userId],
      ),
      this.db.query<{ id: string; device_id: string; received_at: Date; event_count: number }>(
        'SELECT id, device_id, received_at, event_count FROM diagnostic_reports WHERE user_id = $1 ORDER BY received_at',
        [userId],
      ),
      this.db.query<Record<string, unknown> & { report_id: string }>(
        // Same field names as the app's upload (Doc 07), so the export reads like what was sent.
        `SELECT report_id, event_id AS "eventId", event_name AS "eventName", schema_version AS "schemaVersion",
                monotonic_ms::float8 AS "monotonicMs", session_random_id AS "sessionRandomId", duration_ms AS "durationMs",
                result_code AS "resultCode", network_class AS "networkClass", app_build AS "appBuild", os_major AS "osMajor",
                device_class AS "deviceClass"
           FROM diagnostic_events WHERE user_id = $1 ORDER BY report_id, monotonic_ms LIMIT $2`,
        [userId, EXPORT_MAX_EVENTS + 1],
      ),
    ]);
    const byReport = new Map<string, Record<string, unknown>[]>();
    for (const { report_id, ...e } of events.slice(0, EXPORT_MAX_EVENTS)) {
      byReport.set(report_id, [...(byReport.get(report_id) ?? []), e]);
    }
    await writeAudit(this.db.query.bind(this.db), {
      actor: `user:${userId}`,
      action: 'account.export',
      targetType: 'account',
      targetId: userId,
      requestId,
    });
    return {
      format: 'tunedeck-account-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      account: { id: account.id, email: account.email, createdAt: account.created_at.toISOString(), locale: account.locale },
      settings: settings.revision > 0 ? settings : null,
      devices: devices.devices,
      diagnostics: reports.map((r) => ({
        id: r.id,
        deviceId: r.device_id,
        receivedAt: r.received_at.toISOString(),
        eventCount: r.event_count,
        events: byReport.get(r.id) ?? [],
      })),
      diagnosticsTruncated: events.length > EXPORT_MAX_EVENTS,
      staffRoles: roles.map((r) => ({ role: r.role, grantedAt: r.granted_at.toISOString(), revokedAt: r.revoked_at?.toISOString() ?? null })),
    };
  }

  /**
   * Starts deleting the account: from this commit on it cannot sign in, every device is signed out, and a
   * purge is queued. Returns a ticket the user can poll after the web session ends. The purge starts at once.
   */
  async requestDeletion(userId: string, requestId?: string): Promise<{ ticket: string; status: DeletionStatus }> {
    const ticket = randomBytes(32).toString('base64url');
    await this.db.transaction(async (query) => {
      const [user] = await query<{ status: string; oidc_subject: string }>('SELECT status, oidc_subject FROM users WHERE id = $1 FOR UPDATE', [userId]);
      // The guard only lets active accounts through, but two requests can race past it.
      if (user?.status !== 'active') throw new ApiError(HttpStatus.FORBIDDEN, 'ACCOUNT_DELETING');
      await query(`UPDATE users SET status = 'deleting' WHERE id = $1`, [userId]);
      await query('UPDATE devices SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      await query('INSERT INTO account_deletions (ticket_hash, user_id, subject_hash) VALUES ($1, $2, $3)', [
        hashTicket(ticket),
        userId,
        subjectHash(user.oidc_subject),
      ]);
      await writeAudit(query, {
        actor: `user:${userId}`,
        action: 'account.delete_requested',
        targetType: 'account',
        targetId: userId,
        requestId,
      });
    });
    void this.processQueue().catch(() => undefined);
    return { ticket, status: 'deleting' };
  }

  /** Public progress check by ticket. Unknown and expired tickets look the same. */
  async status(ticket: string): Promise<{ status: DeletionStatus; requestedAt: string; deadline: string; completedAt: string | null }> {
    if (!TICKET.test(ticket)) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    const [row] = await this.db.query<{ status: 'pending' | 'completed' | 'failed'; requested_at: Date; completed_at: Date | null }>(
      'SELECT status, requested_at, completed_at FROM account_deletions WHERE ticket_hash = $1',
      [hashTicket(ticket)],
    );
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    return {
      status: row.status === 'pending' ? 'deleting' : row.status,
      requestedAt: row.requested_at.toISOString(),
      deadline: new Date(row.requested_at.getTime() + DELETION_DEADLINE_DAYS * 86_400_000).toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
    };
  }

  /** Purges every open request. Returns how many completed (0 if another instance holds the queue). */
  processQueue(): Promise<number> {
    this.working ??= this.drain().finally(() => (this.working = null));
    return this.working;
  }

  /**
   * Runs one open request now (staff "retry" on /admin/jobs). Takes the same queue lock as the background
   * run, so the two never purge at once; 'busy' means another run holds it and will reach this job anyway.
   */
  async retryOne(ticketHash: string): Promise<'completed' | 'failed' | 'busy'> {
    const client = await this.pool.connect();
    try {
      const [{ locked }] = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY])).rows;
      if (!locked) return 'busy';
      try {
        const [job] = await this.db.query<{ user_id: string }>(
          `SELECT user_id FROM account_deletions WHERE ticket_hash = $1 AND status <> 'completed'`,
          [ticketHash],
        );
        if (!job) return 'completed';
        return (await this.attempt(ticketHash, job.user_id)) ? 'completed' : 'failed';
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }

  /** One purge attempt; a failure is counted on the request and logged without details. */
  private async attempt(ticketHash: string, userId: string): Promise<boolean> {
    try {
      await this.purge(ticketHash, userId);
      return true;
    } catch (err) {
      await this.db
        .query(`UPDATE account_deletions SET status = 'failed', attempts = attempts + 1, last_attempt_at = now() WHERE ticket_hash = $1`, [ticketHash])
        .catch(() => undefined);
      this.logger.log('ERROR', { eventCode: 'ACCOUNT_PURGE_FAILED', errorName: (err as Error)?.name ?? 'Error' });
      return false;
    }
  }

  private async drain(): Promise<number> {
    const client = await this.pool.connect();
    try {
      const [{ locked }] = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY])).rows;
      if (!locked) return 0;
      try {
        await this.db.query(
          `DELETE FROM account_deletions WHERE status = 'completed' AND completed_at < now() - make_interval(days => $1)`,
          [TICKET_KEEP_DAYS],
        );
        const open = await this.db.query<{ ticket_hash: string; user_id: string }>(
          `SELECT ticket_hash, user_id FROM account_deletions WHERE status <> 'completed' ORDER BY requested_at`,
        );
        let done = 0;
        for (const job of open) {
          if (this.stopped) break;
          if (await this.attempt(job.ticket_hash, job.user_id)) done++;
        }
        return done;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Removes the account's data in one transaction and leaves a tombstone: the users row keeps only its id,
   * creation time and status, so station history and the audit trail still resolve. The OIDC subject is
   * replaced, so signing in again with the same identity starts a new, empty account.
   */
  private async purge(ticketHash: string, userId: string): Promise<void> {
    await this.db.transaction(async (query) => {
      // diagnostic_events has no foreign key to devices; diagnostic_reports cascades to it.
      await query('DELETE FROM diagnostic_reports WHERE user_id = $1', [userId]);
      await query('DELETE FROM diagnostic_events WHERE user_id = $1', [userId]);
      await query('DELETE FROM devices WHERE user_id = $1', [userId]);
      await query('DELETE FROM account_preferences WHERE owner_id = $1', [userId]);
      await query('DELETE FROM staff_roles WHERE user_id = $1', [userId]);
      await query(
        `UPDATE users SET status = 'deleted', oidc_subject = 'deleted:' || id::text, locale = NULL, email = NULL, email_verified = false, deleted_at = now() WHERE id = $1`,
        [userId],
      );
      await query(
        `UPDATE account_deletions SET status = 'completed', attempts = attempts + 1, last_attempt_at = now(), completed_at = now() WHERE ticket_hash = $1`,
        [ticketHash],
      );
      await writeAudit(query, { actor: 'system:account-deletion', action: 'account.deleted', targetType: 'account', targetId: userId });
    });
    this.logger.log('INFO', { eventCode: 'ACCOUNT_PURGED' });
  }
}

@Controller('v1/me')
@UseGuards(AuthGuard)
export class MyAccountController {
  constructor(private readonly account: AccountService) {}

  /**
   * Who am I: the account id the customer reads out to support (Doc 17 /admin/users looks it up), plus its
   * state. Nothing else: no subject, email or roles.
   */
  @Get()
  async me(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.account.me(req.actor!.userId);
  }

  /** Doc 17 export: a JSON download of the account's own data. */
  @Get('export')
  async export(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="tunedeck-export-${new Date().toISOString().slice(0, 10)}.json"`);
    return this.account.export(req.actor!.userId, req.requestId);
  }

  /** Doc 17 deletion: needs a sign-in from the last 5 minutes. 202, because the purge finishes afterwards. */
  @Delete('account')
  @HttpCode(HttpStatus.ACCEPTED)
  async delete(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    requireRecentSignIn(req);
    res.setHeader('Cache-Control', 'no-store');
    return this.account.requestDeletion(req.actor!.userId, req.requestId);
  }
}

/** Progress of a deletion, readable without signing in (the account can no longer sign in). */
@Controller('v1/account-deletions')
export class AccountDeletionStatusController {
  constructor(private readonly account: AccountService) {}

  @Get(':ticket')
  async status(@Param('ticket') ticket: string, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.account.status(ticket);
  }
}
