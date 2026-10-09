import { createHash, randomBytes } from 'node:crypto';
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { requireRecentSignIn } from '../auth/recent-sign-in';
import { ApiError } from '../common/api-error';
import { StructuredLogger } from '../common/logger';
import { Database } from '../db/database';
import { afterFailure, jobErrorCode } from '../jobs/retry-policy';
import { AccountService } from './account';

/** Doc 17: a download link is valid for at most 15 minutes. */
export const EXPORT_LINK_MINUTES = 15;
/** Doc 17: user exports are deleted within 24 hours (the expiry is set in migration 017). */
const CLAIM_STALE_MINUTES = 5;
const SWEEP_EVERY_MS = 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINK = /^[A-Za-z0-9_-]{43}$/;
const hashLink = (token: string) => createHash('sha256').update(token).digest('hex');

export type ExportStatus = 'pending' | 'ready' | 'failed';
/** The row's state in the queue. Users see 'dead_letter' as 'failed'; a retrying export is still 'pending' to them. */
type ExportJobState = 'pending' | 'ready' | 'dead_letter';
/** What a staff retry left behind (/admin/jobs). */
export type ExportRetryOutcome = 'completed' | 'retrying' | 'dead_letter' | 'busy' | 'superseded' | 'gone';

export interface ExportView {
  id: string;
  status: ExportStatus;
  requestedAt: string;
  readyAt: string | null;
  expiresAt: string;
}

interface Row {
  id: string;
  status: ExportJobState;
  requested_at: Date;
  ready_at: Date | null;
  expires_at: Date;
}

const view = (r: Row): ExportView => ({
  id: r.id,
  status: r.status === 'dead_letter' ? 'failed' : r.status,
  requestedAt: r.requested_at.toISOString(),
  readyAt: r.ready_at?.toISOString() ?? null,
  expiresAt: r.expires_at.toISOString(),
});

/**
 * Doc 17 `POST /me/exports`: the account's data is built in the background into `account_exports`, then
 * fetched through a short-lived link that works without a sign-in (so a phone can open it in a browser).
 * Built exports are deleted after 24 hours. Failed builds back off per the shared retry policy (jobs/retry-policy)
 * and are dead-lettered after 5 attempts; the user then sees 'failed' and can ask again.
 */
@Injectable()
export class AccountExportsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private working: Promise<number> | null = null;

  constructor(
    private readonly db: Database,
    private readonly account: AccountService,
    private readonly logger: StructuredLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.processQueue().catch(() => undefined), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.working?.catch(() => undefined);
  }

  /** Starts an export, or returns the one already being built for this account. */
  async request(userId: string): Promise<ExportView> {
    const [created] = await this.db.query<Row>(
      `INSERT INTO account_exports (user_id) VALUES ($1) ON CONFLICT (user_id) WHERE status = 'pending' DO NOTHING
       RETURNING id, status, requested_at, ready_at, expires_at`,
      [userId],
    );
    const row =
      created ??
      (await this.db.query<Row>(`SELECT id, status, requested_at, ready_at, expires_at FROM account_exports WHERE user_id = $1 AND status = 'pending'`, [userId]))[0];
    if (!row) throw new ApiError(HttpStatus.CONFLICT, 'JOB_BUSY'); // finished between the two statements; asking again works
    void this.processQueue().catch(() => undefined);
    return view(row);
  }

  /** The account's own export; anyone else's (or an expired one) is 404. Reading it changes nothing. */
  async get(userId: string, id: string): Promise<ExportView> {
    if (!UUID.test(id)) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    const [row] = await this.db.query<Row>(
      `SELECT id, status, requested_at, ready_at, expires_at FROM account_exports WHERE id = $1 AND user_id = $2 AND expires_at > now()`,
      [id, userId],
    );
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    return view(row);
  }

  /** A new 15-minute download link for a ready export; the previous link stops working. 409 until it is ready. */
  async link(userId: string, id: string): Promise<{ path: string; expiresAt: string }> {
    const row = await this.get(userId, id);
    if (row.status !== 'ready') throw new ApiError(HttpStatus.CONFLICT, 'EXPORT_NOT_READY', { status: row.status });
    const token = randomBytes(32).toString('base64url');
    const [link] = await this.db.query<{ link_expires_at: Date }>(
      `UPDATE account_exports SET link_hash = $2, link_expires_at = LEAST(now() + make_interval(mins => $3), expires_at)
       WHERE id = $1 RETURNING link_expires_at`,
      [id, hashLink(token), EXPORT_LINK_MINUTES],
    );
    return { path: `/v1/export-downloads/${token}`, expiresAt: link.link_expires_at.toISOString() };
  }

  /** The export behind a live link. Unknown, replaced and expired links look the same. */
  async download(token: string): Promise<{ payload: unknown; readyAt: Date }> {
    if (!LINK.test(token)) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    const [row] = await this.db.query<{ payload: unknown; ready_at: Date }>(
      `SELECT payload, ready_at FROM account_exports
       WHERE link_hash = $1 AND status = 'ready' AND link_expires_at > now() AND expires_at > now()`,
      [hashLink(token)],
    );
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    return { payload: row.payload, readyAt: row.ready_at };
  }

  /** Builds every waiting export and deletes expired ones. Returns how many were built. Safe on several instances. */
  processQueue(): Promise<number> {
    this.working ??= this.drain().finally(() => (this.working = null));
    return this.working;
  }

  /**
   * Builds one export now (staff "retry" on /admin/jobs). A dead-lettered export starts a new round of attempts,
   * unless the account has since asked for a new one ('superseded'). 'busy' means a worker is building it.
   */
  async retryOne(id: string): Promise<ExportRetryOutcome> {
    let reset: { id: string }[];
    try {
      reset = await this.db.query<{ id: string }>(
        `UPDATE account_exports SET status = 'pending', next_attempt_at = NULL, dead_lettered_at = NULL,
                attempts = CASE WHEN status = 'dead_letter' THEN 0 ELSE attempts END
          WHERE id = $1 AND status <> 'ready' AND expires_at > now()
            AND (claimed_at IS NULL OR claimed_at < now() - make_interval(mins => $2))
          RETURNING id`,
        [id, CLAIM_STALE_MINUTES],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return 'superseded'; // account_exports_one_pending
      throw err;
    }
    if (!reset[0]) {
      const [row] = await this.db.query<{ status: ExportJobState }>(`SELECT status FROM account_exports WHERE id = $1 AND expires_at > now()`, [id]);
      return !row ? 'gone' : row.status === 'ready' ? 'completed' : 'busy';
    }
    const job = await this.claim(id);
    if (!job) return 'busy';
    const result = await this.build(job);
    return result === 'ready' ? 'completed' : result;
  }

  private async drain(): Promise<number> {
    await this.db.query(`DELETE FROM account_exports WHERE expires_at <= now()`);
    let built = 0;
    for (;;) {
      const job = await this.claim(null);
      if (!job) return built;
      const result = await this.build(job);
      if (result === 'ready') built++;
      // Leave the rest for the next sweep rather than spinning on a failing database.
      else return built;
    }
  }

  /** Takes the oldest due export (or the given one) for building. Counts the attempt. */
  private async claim(id: string | null): Promise<{ id: string; user_id: string; attempts: number } | undefined> {
    const [job] = await this.db.query<{ id: string; user_id: string; attempts: number }>(
      `UPDATE account_exports SET claimed_at = now(), last_attempt_at = now(), attempts = attempts + 1
       WHERE id = (SELECT id FROM account_exports
                   WHERE status = 'pending' AND ($2::uuid IS NULL OR id = $2)
                     AND (next_attempt_at IS NULL OR next_attempt_at <= now())
                     AND (claimed_at IS NULL OR claimed_at < now() - make_interval(mins => $1))
                   ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id, user_id, attempts`,
      [CLAIM_STALE_MINUTES, id],
    );
    return job;
  }

  /** One build attempt. A failure schedules the next try, or dead-letters the export after the 5th. */
  private async build(job: { id: string; user_id: string; attempts: number }): Promise<'ready' | 'retrying' | 'dead_letter'> {
    try {
      const payload = await this.account.export(job.user_id);
      await this.db.query(
        `UPDATE account_exports SET status = 'ready', ready_at = now(), payload = $2::jsonb, claimed_at = NULL, next_attempt_at = NULL WHERE id = $1`,
        [job.id, JSON.stringify(payload)],
      );
      return 'ready';
    } catch (err) {
      // The claim already counted this attempt.
      const next = afterFailure(job.attempts - 1);
      await this.db
        .query(
          `UPDATE account_exports SET claimed_at = NULL, last_error_code = $3,
                  status = CASE WHEN $2::int IS NULL THEN 'dead_letter' ELSE 'pending' END,
                  next_attempt_at = now() + make_interval(secs => $2::int),
                  dead_lettered_at = CASE WHEN $2::int IS NULL THEN now() END
            WHERE id = $1`,
          [job.id, next.retryInSeconds, jobErrorCode(err)],
        )
        .catch(() => undefined);
      this.logger.log('ERROR', {
        eventCode: next.retryInSeconds === null ? 'ACCOUNT_EXPORT_DEAD_LETTERED' : 'ACCOUNT_EXPORT_FAILED',
        errorName: (err as Error)?.name ?? 'Error',
      });
      return next.retryInSeconds === null ? 'dead_letter' : 'retrying';
    }
  }
}

@Controller('v1/me/exports')
@UseGuards(AuthGuard)
export class MyExportsController {
  constructor(private readonly exports: AccountExportsService) {}

  /** Doc 17: needs a sign-in from the last 5 minutes. 202; poll GET /v1/me/exports/{id}. */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async request(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    requireRecentSignIn(req);
    res.setHeader('Cache-Control', 'no-store');
    return this.exports.request(req.actor!.userId);
  }

  @Get(':id')
  async get(@Req() req: Request, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.exports.get(req.actor!.userId, id);
  }

  /** Mints the download link (a POST, since it replaces the previous link; GET never changes anything). Needs a sign-in from the last 5 minutes. */
  @Post(':id/link')
  @HttpCode(HttpStatus.CREATED)
  async link(@Req() req: Request, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    // The link hands out the whole account's data, so it needs the same recent sign-in as asking for the export.
    requireRecentSignIn(req);
    res.setHeader('Cache-Control', 'no-store');
    return this.exports.link(req.actor!.userId, id);
  }
}

/** The download link itself: no sign-in, the unguessable link is the permission. */
@Controller('v1/export-downloads')
export class ExportDownloadController {
  constructor(private readonly exports: AccountExportsService) {}

  @Get(':token')
  async download(@Param('token') token: string, @Res({ passthrough: true }) res: Response) {
    const { payload, readyAt } = await this.exports.download(token);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Disposition', `attachment; filename="tunedeck-export-${readyAt.toISOString().slice(0, 10)}.json"`);
    return payload;
  }
}
