import { Controller, Get, HttpStatus, Injectable, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { writeAudit } from '../audit/audit';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { Severity } from '../common/logger';
import { Database } from '../db/database';
import { RequireRoles, StaffGuard } from '../staff/staff';
import { LOG_RETENTION_DAYS } from './log-store';

const SEVERITIES: Severity[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const SERVICES = ['api'];
const MAX_WINDOW_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_WINDOW_MS = 3600 * 1000;
const MAX_LIMIT = 200;

export interface LogQuery {
  from: Date;
  to: Date;
  severity: Severity[];
  service?: string;
  build?: string;
  eventCode?: string;
  requestId?: string;
  status?: number;
  limit: number;
  cursor?: { at: string; id: string };
}

export interface LogRow {
  id: string;
  timestamp: string;
  severity: Severity;
  service: string;
  environment: string;
  build: string;
  eventCode: string;
  requestId: string | null;
  method: string | null;
  route: string | null;
  status: number | null;
  durationMs: number | null;
  actorId: string | null;
  errorName: string | null;
  errorCode: string | null;
}

const bad = (field: string, reason = 'invalid') => new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field, reason });

function text(q: Record<string, unknown>, field: string, pattern: RegExp): string | undefined {
  const v = q[field];
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !pattern.test(v)) throw bad(field);
  return v;
}

function time(q: Record<string, unknown>, field: string): Date | undefined {
  const v = text(q, field, /^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:\d{2})$/);
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw bad(field);
  return d;
}

/** Parses and bounds a log search: at most a 7-day window inside the retention period, at most 200 rows a page. */
export function parseLogQuery(q: Record<string, unknown>, now = new Date()): LogQuery {
  const to = time(q, 'to') ?? now;
  const from = time(q, 'from') ?? new Date(to.getTime() - DEFAULT_WINDOW_MS);
  if (from >= to) throw bad('from', 'after_to');
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) throw bad('from', 'window_too_long');
  const severityRaw = text(q, 'severity', /^[A-Z,]{1,40}$/);
  const severity = severityRaw ? severityRaw.split(',') : [];
  if (severity.some((s) => !SEVERITIES.includes(s as Severity))) throw bad('severity');
  const service = text(q, 'service', /^[a-z-]{1,20}$/);
  if (service && !SERVICES.includes(service)) throw bad('service');
  const statusRaw = text(q, 'status', /^[1-5]\d\d$/);
  const limitRaw = text(q, 'limit', /^\d{1,3}$/);
  const limit = limitRaw ? Number(limitRaw) : 50;
  if (limit < 1 || limit > MAX_LIMIT) throw bad('limit');
  const cursorRaw = text(q, 'cursor', /^[A-Za-z0-9_-]{1,120}$/);
  let cursor: LogQuery['cursor'];
  if (cursorRaw) {
    const [at, id] = Buffer.from(cursorRaw, 'base64url').toString().split('|');
    if (!at || !/^\d{1,19}$/.test(id ?? '') || Number.isNaN(new Date(at).getTime())) throw bad('cursor', 'malformed');
    cursor = { at, id };
  }
  return {
    from,
    to,
    severity: severity as Severity[],
    service,
    build: text(q, 'build', /^[A-Za-z0-9._+-]{1,64}$/),
    eventCode: text(q, 'eventCode', /^[A-Z][A-Z0-9_]{0,63}$/),
    requestId: text(q, 'requestId', /^[A-Za-z0-9._-]{8,64}$/),
    status: statusRaw ? Number(statusRaw) : undefined,
    limit,
    cursor,
  };
}

@Injectable()
export class LogsService {
  constructor(private readonly db: Database) {}

  /** Runs a search and records who searched for what in the audit trail, in one transaction. */
  async search(actor: { userId: string; requestId: string }, q: LogQuery): Promise<{ logs: LogRow[]; nextCursor: string | null; retentionDays: number }> {
    const where = ['logged_at >= $1', 'logged_at < $2'];
    const params: unknown[] = [q.from.toISOString(), q.to.toISOString()];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.severity.length) add('severity = ANY(?)', q.severity);
    if (q.service) add('service = ?', q.service);
    if (q.build) add('build = ?', q.build);
    if (q.eventCode) add('event_code = ?', q.eventCode);
    if (q.requestId) add('request_id = ?', q.requestId);
    if (q.status) add('status = ?', q.status);
    if (q.cursor) {
      params.push(q.cursor.at, q.cursor.id);
      where.push(`(logged_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
    }
    params.push(q.limit + 1);
    return this.db.transaction(async (query) => {
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: 'logs.search',
        targetType: 'operational_logs',
        targetId: '*',
        changes: {
          from: q.from.toISOString(),
          to: q.to.toISOString(),
          ...(q.severity.length && { severity: q.severity }),
          ...(q.service && { service: q.service }),
          ...(q.build && { build: q.build }),
          ...(q.eventCode && { eventCode: q.eventCode }),
          ...(q.requestId && { requestId: q.requestId }),
          ...(q.status && { status: q.status }),
          ...(q.cursor && { page: 'next' }),
        },
        requestId: actor.requestId,
      });
      const rows = await query<{
        id: string;
        logged_at: Date;
        severity: Severity;
        service: string;
        environment: string;
        build: string;
        event_code: string;
        request_id: string | null;
        method: string | null;
        route: string | null;
        status: number | null;
        duration_ms: number | null;
        actor_id: string | null;
        error_name: string | null;
        error_code: string | null;
      }>(
        `SELECT id::text, logged_at, severity, service, environment, build, event_code, request_id, method, route, status, duration_ms, actor_id, error_name, error_code
           FROM operational_logs WHERE ${where.join(' AND ')}
          ORDER BY logged_at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        logs: page.map((r) => ({
          id: r.id,
          timestamp: r.logged_at.toISOString(),
          severity: r.severity,
          service: r.service,
          environment: r.environment,
          build: r.build,
          eventCode: r.event_code,
          requestId: r.request_id,
          method: r.method,
          route: r.route,
          status: r.status,
          durationMs: r.duration_ms,
          actorId: r.actor_id,
          errorName: r.error_name,
          errorCode: r.error_code,
        })),
        nextCursor: rows.length > q.limit ? Buffer.from(`${last.logged_at.toISOString()}|${last.id}`).toString('base64url') : null,
        retentionDays: LOG_RETENTION_DAYS,
      };
    });
  }
}

/** Staff log search (Doc 17 /admin/logs): operators and admins, bounded filters, every search audited. */
@Controller('v1/admin/logs')
@UseGuards(AuthGuard, StaffGuard)
@RequireRoles('operator', 'admin')
export class AdminLogsController {
  constructor(private readonly logs: LogsService) {}

  @Get()
  async search(@Req() req: Request, @Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.logs.search({ userId: req.actor!.userId, requestId: req.requestId }, parseLogQuery(q));
  }
}
