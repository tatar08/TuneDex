import { Body, Controller, Header, Get, HttpCode, HttpStatus, Inject, Injectable, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccountService } from '../account/account';
import { AccountExportsService } from '../account/exports';
import { writeAudit } from '../audit/audit';
import { parseExportReason } from '../audit/audit-search';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, AppConfig } from '../config';
import { Database } from '../db/database';
import { DevicesService } from '../devices/devices.service';
import { JOB_KINDS, JobKind, jobsCte, JobState } from './queues';
import { MAX_ATTEMPTS } from './retry-policy';
import { RequireRoles, StaffGuard } from '../staff/staff';

/** A staff retry right after an attempt only repeats it; the workers retry on their own per the retry policy. */
export const RETRY_COOLDOWN_SECONDS = 60;
/** Doc 17 retry ceiling: staff retries of one job, counted from the job.retry audit over the last 24 hours. */
export const MANUAL_RETRY_LIMIT = 3;
const MANUAL_RETRY_WINDOW_HOURS = 24;
export const JOBS_PAGE = 100;
/** Completed jobs stay listed this long so staff can see a retry land. */
const COMPLETED_SHOWN_DAYS = 7;

export type { JobKind, JobState };
/** Kept as `status` on the wire: pending, retrying (failed, next try scheduled), dead_letter (waits for staff), completed. */
export type JobStatus = JobState;

export interface Job {
  /** Opaque id (see jobsCte). It cannot be turned back into a ticket or a user id. */
  id: string;
  kind: JobKind;
  status: JobStatus;
  requestedAt: string;
  /** Attempts in the current round; the job is dead-lettered at maxAttempts. */
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: string | null;
  /** When the worker tries next; null when dead-lettered, completed or not yet scheduled (runs on the next sweep). */
  nextAttemptAt: string | null;
  /** A code only (e.g. IDP_DELETE_FAILED, DB_40001), never a message. */
  lastErrorCode: string | null;
  completedAt: string | null;
  /** Account deletions only: Doc 17's 30 days from the request. */
  deadline: string | null;
}

export interface QueueSummary {
  kind: JobKind;
  pending: number;
  retrying: number;
  deadLetter: number;
  /** Request time of the oldest job not yet done (dead letters included). */
  oldestOpenAt: string | null;
}

const STATUSES: Record<string, JobStatus[]> = {
  open: ['pending', 'retrying', 'dead_letter'],
  failed: ['retrying', 'dead_letter'],
  dead_letter: ['dead_letter'],
  completed: ['completed'],
  all: ['pending', 'retrying', 'dead_letter', 'completed'],
};
const JOB_ID = /^(?:[0-9a-f]{64}|ex_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|se_[0-9a-f]{64})$/;
const kindOf = (id: string): JobKind => (id.startsWith('ex_') ? 'account_export' : id.startsWith('se_') ? 'idp_session_end' : 'account_deletion');

export function parseJobFilter(q: Record<string, unknown>): keyof typeof STATUSES {
  const s = q.status ?? 'open';
  if (typeof s !== 'string' || !(s in STATUSES)) throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field: 'status', reason: 'invalid' });
  return s;
}

interface JobRow {
  id: string;
  kind: JobKind;
  state: JobState;
  requested_at: Date;
  attempts: number;
  last_attempt_at: Date | null;
  next_attempt_at: Date | null;
  last_error_code: string | null;
  completed_at: Date | null;
  deadline: Date | null;
}

/**
 * Doc 17 /admin/jobs: every background queue (account deletions, account exports, Keycloak session ends after a
 * device sign-out) with state, age, attempts, next attempt and last error code, and an authorized retry.
 * All queues follow the shared retry policy (retry-policy.ts): backoff, 5 attempts, then dead_letter. A
 * dead-lettered deletion keeps the account locked and must be retried by staff to meet the 30-day deadline.
 */
@Injectable()
export class JobsService {
  constructor(
    private readonly db: Database,
    private readonly account: AccountService,
    private readonly exports: AccountExportsService,
    private readonly devices: DevicesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get cte() {
    return jobsCte(this.config.idpAdmin !== null);
  }

  async list(filter: keyof typeof STATUSES): Promise<{ jobs: Job[]; counts: Record<JobStatus, number>; queues: QueueSummary[]; truncated: boolean }> {
    const shown = `(state <> 'completed' OR completed_at > now() - make_interval(days => ${COMPLETED_SHOWN_DAYS}))`;
    const [rows, counts] = await Promise.all([
      this.db.query<JobRow>(
        `${this.cte} SELECT * FROM jobs WHERE state = ANY($1) AND ${shown}
          ORDER BY (state = 'dead_letter') DESC, (state = 'retrying') DESC, requested_at LIMIT $2`,
        [STATUSES[filter], JOBS_PAGE + 1],
      ),
      this.db.query<{ kind: JobKind; state: JobStatus; n: string; oldest: Date }>(
        `${this.cte} SELECT kind, state, count(*) AS n, min(requested_at) AS oldest FROM jobs WHERE ${shown} GROUP BY kind, state`,
      ),
    ]);
    const c: Record<JobStatus, number> = { pending: 0, retrying: 0, dead_letter: 0, completed: 0 };
    const kinds = this.config.idpAdmin ? JOB_KINDS : JOB_KINDS.filter((k) => k !== 'idp_session_end');
    const queues = new Map<JobKind, QueueSummary>(kinds.map((kind) => [kind, { kind, pending: 0, retrying: 0, deadLetter: 0, oldestOpenAt: null }]));
    for (const r of counts) {
      c[r.state] += Number(r.n);
      const q = queues.get(r.kind)!;
      if (r.state === 'completed') continue;
      if (r.state === 'dead_letter') q.deadLetter = Number(r.n);
      else q[r.state] = Number(r.n);
      const oldest = r.oldest.toISOString();
      if (!q.oldestOpenAt || oldest < q.oldestOpenAt) q.oldestOpenAt = oldest;
    }
    return {
      jobs: rows.slice(0, JOBS_PAGE).map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.state,
        requestedAt: r.requested_at.toISOString(),
        attempts: r.attempts,
        maxAttempts: MAX_ATTEMPTS,
        lastAttemptAt: r.last_attempt_at?.toISOString() ?? null,
        nextAttemptAt: r.state === 'pending' || r.state === 'retrying' ? (r.next_attempt_at?.toISOString() ?? null) : null,
        lastErrorCode: r.last_error_code,
        completedAt: r.completed_at?.toISOString() ?? null,
        deadline: r.deadline?.toISOString() ?? null,
      })),
      counts: c,
      queues: [...queues.values()],
      truncated: rows.length > JOBS_PAGE,
    };
  }

  /**
   * Runs one job now; a dead-lettered job starts a new round of attempts. Idempotent: a job that already finished
   * is reported as completed and nothing runs. At most MANUAL_RETRY_LIMIT staff retries per job in 24 hours.
   * Every attempt is audited as job.retry with the reason and the outcome.
   */
  async retry(actor: { userId: string; requestId?: string }, id: string, reason: string): Promise<{ status: JobStatus }> {
    if (!JOB_ID.test(id)) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    const kind = kindOf(id);
    if (kind === 'idp_session_end' && !this.config.idpAdmin) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    const [job] = await this.db.query<{ state: JobStatus; attempts: number; since: number | null }>(
      `${this.cte} SELECT state, attempts, extract(epoch FROM now() - last_attempt_at)::int AS since FROM jobs WHERE id = $1`,
      [id],
    );
    if (!job) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    if (job.state === 'completed') return { status: 'completed' };
    if (job.since !== null && job.since < RETRY_COOLDOWN_SECONDS) {
      throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'JOB_RETRY_TOO_SOON', { retryAfterSeconds: RETRY_COOLDOWN_SECONDS - job.since });
    }
    const [{ n }] = await this.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_events
        WHERE target_type = 'job' AND target_id = $1 AND action = 'job.retry' AND occurred_at > now() - make_interval(hours => $2)`,
      [id, MANUAL_RETRY_WINDOW_HOURS],
    );
    if (Number(n) >= MANUAL_RETRY_LIMIT) {
      throw new ApiError(HttpStatus.CONFLICT, 'JOB_RETRY_LIMIT', { limit: MANUAL_RETRY_LIMIT, windowHours: MANUAL_RETRY_WINDOW_HOURS });
    }
    const outcome = await this.run(kind, id);
    await writeAudit(this.db.query.bind(this.db), {
      actor: `user:${actor.userId}`,
      action: 'job.retry',
      targetType: 'job',
      targetId: id,
      reason,
      changes: { kind, stateBefore: job.state, attemptsBefore: job.attempts, result: outcome },
      requestId: actor.requestId,
    });
    return { status: outcome };
  }

  private async run(kind: JobKind, id: string): Promise<JobStatus> {
    if (kind === 'account_deletion') {
      const r = await this.account.retryOne(id);
      if (r === 'busy') throw new ApiError(HttpStatus.CONFLICT, 'JOB_BUSY');
      return r === 'failed' ? 'retrying' : r;
    }
    if (kind === 'account_export') {
      const r = await this.exports.retryOne(id.slice(3));
      if (r === 'busy') throw new ApiError(HttpStatus.CONFLICT, 'JOB_BUSY');
      // The account asked for a new export since; that one is in the queue instead.
      if (r === 'superseded') throw new ApiError(HttpStatus.CONFLICT, 'JOB_SUPERSEDED');
      if (r === 'gone') throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      return r;
    }
    const [device] = await this.db.query<{ user_id: string; id: string }>(
      `SELECT user_id, id FROM devices
        WHERE revoked_at IS NOT NULL AND idp_session_id IS NOT NULL AND idp_session_ended_at IS NULL
          AND encode(sha256(convert_to(user_id::text || ':' || id::text, 'UTF8')), 'hex') = $1`,
      [id.slice(3)],
    );
    const r = device ? await this.devices.retrySessionEnd(device.user_id, device.id) : null;
    if (r === null || r === 'not_configured') throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    return r === 'ended' ? 'completed' : r;
  }
}

@Controller('v1/admin/jobs')
@UseGuards(AuthGuard, StaffGuard)
@RequireRoles('operator', 'admin')
export class AdminJobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  async list(@Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.jobs.list(parseJobFilter(q));
  }

  /** Body `{ reason }` (10–500 characters), recorded with the outcome. */
  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async retry(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.jobs.retry({ userId: req.actor!.userId, requestId: req.requestId }, id, parseExportReason(body));
  }
}
