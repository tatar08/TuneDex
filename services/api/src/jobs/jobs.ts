import { Body, Controller, Get, HttpCode, HttpStatus, Injectable, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccountService, DELETION_DEADLINE_DAYS } from '../account/account';
import { writeAudit } from '../audit/audit';
import { parseExportReason } from '../audit/audit-search';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { Database } from '../db/database';
import { RequireRoles, StaffGuard } from '../staff/staff';

/** A staff retry right after an attempt only repeats it; the background run already retries every 10 minutes. */
export const RETRY_COOLDOWN_SECONDS = 60;
export const JOBS_PAGE = 100;
/** Completed jobs stay listed this long so staff can see a retry land. */
const COMPLETED_SHOWN_DAYS = 7;

export type JobKind = 'account_deletion';
export type JobStatus = 'pending' | 'failed' | 'completed';

export interface Job {
  /** Opaque id: the request's ticket hash. It cannot be turned back into the ticket and holds no user id. */
  id: string;
  kind: JobKind;
  status: JobStatus;
  requestedAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  completedAt: string | null;
  deadline: string;
}

const STATUSES: Record<string, JobStatus[]> = { open: ['pending', 'failed'], failed: ['failed'], completed: ['completed'], all: ['pending', 'failed', 'completed'] };
const JOB_ID = /^[0-9a-f]{64}$/;

export function parseJobFilter(q: Record<string, unknown>): keyof typeof STATUSES {
  const s = q.status ?? 'open';
  if (typeof s !== 'string' || !(s in STATUSES)) throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field: 'status', reason: 'invalid' });
  return s;
}

/**
 * Doc 17 /admin/jobs: background work with its age and attempts, and an authorized retry. Today the only
 * queue is account deletion. There is no dead-letter state for it: Doc 17 requires every deletion to finish,
 * so a failed one keeps being retried in the background and stays on this page until it does.
 */
@Injectable()
export class JobsService {
  constructor(
    private readonly db: Database,
    private readonly account: AccountService,
  ) {}

  async list(filter: keyof typeof STATUSES): Promise<{ jobs: Job[]; counts: Record<JobStatus, number>; truncated: boolean }> {
    const [rows, counts] = await Promise.all([
      this.db.query<{ ticket_hash: string; status: JobStatus; requested_at: Date; attempts: number; last_attempt_at: Date | null; completed_at: Date | null }>(
        `SELECT ticket_hash, status, requested_at, attempts, last_attempt_at, completed_at FROM account_deletions
          WHERE status = ANY($1) AND (status <> 'completed' OR completed_at > now() - make_interval(days => $2))
          ORDER BY (status = 'failed') DESC, requested_at LIMIT $3`,
        [STATUSES[filter], COMPLETED_SHOWN_DAYS, JOBS_PAGE + 1],
      ),
      this.db.query<{ status: JobStatus; n: string }>(
        `SELECT status, count(*) AS n FROM account_deletions
          WHERE status <> 'completed' OR completed_at > now() - make_interval(days => $1) GROUP BY status`,
        [COMPLETED_SHOWN_DAYS],
      ),
    ]);
    const c: Record<JobStatus, number> = { pending: 0, failed: 0, completed: 0 };
    for (const r of counts) c[r.status] = Number(r.n);
    return {
      jobs: rows.slice(0, JOBS_PAGE).map((r) => ({
        id: r.ticket_hash,
        kind: 'account_deletion',
        status: r.status,
        requestedAt: r.requested_at.toISOString(),
        attempts: r.attempts,
        lastAttemptAt: r.last_attempt_at?.toISOString() ?? null,
        completedAt: r.completed_at?.toISOString() ?? null,
        deadline: new Date(r.requested_at.getTime() + DELETION_DEADLINE_DAYS * 86_400_000).toISOString(),
      })),
      counts: c,
      truncated: rows.length > JOBS_PAGE,
    };
  }

  /**
   * Runs one job now. Idempotent: a job that already finished is reported as completed and nothing runs.
   * Every attempt is audited as job.retry with the reason and the outcome.
   */
  async retry(actor: { userId: string; requestId?: string }, id: string, reason: string): Promise<{ status: JobStatus }> {
    if (!JOB_ID.test(id)) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    const [job] = await this.db.query<{ status: JobStatus; attempts: number; since: number | null }>(
      `SELECT status, attempts, extract(epoch FROM now() - last_attempt_at)::int AS since FROM account_deletions WHERE ticket_hash = $1`,
      [id],
    );
    if (!job) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    if (job.status === 'completed') return { status: 'completed' };
    if (job.since !== null && job.since < RETRY_COOLDOWN_SECONDS) {
      throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'JOB_RETRY_TOO_SOON', { retryAfterSeconds: RETRY_COOLDOWN_SECONDS - job.since });
    }
    const outcome = await this.account.retryOne(id);
    if (outcome === 'busy') throw new ApiError(HttpStatus.CONFLICT, 'JOB_BUSY');
    await writeAudit(this.db.query.bind(this.db), {
      actor: `user:${actor.userId}`,
      action: 'job.retry',
      targetType: 'job',
      targetId: id,
      reason,
      changes: { kind: 'account_deletion', attemptsBefore: job.attempts, result: outcome },
      requestId: actor.requestId,
    });
    return { status: outcome };
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
  async retry(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.jobs.retry({ userId: req.actor!.userId, requestId: req.requestId }, id, parseExportReason(body));
  }
}
