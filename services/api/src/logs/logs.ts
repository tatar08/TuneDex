import { Body, Controller, Get, HttpCode, HttpStatus, Injectable, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { writeAudit } from '../audit/audit';
import { csvCell, EXPORT_MAX_ROWS, parseExportReason } from '../audit/audit-search';
import { AuthGuard } from '../auth/auth.guard';
import { requireRecentMfa } from '../auth/recent-sign-in';
import { ApiError } from '../common/api-error';
import { Severity } from '../common/logger';
import { Database } from '../db/database';
import { RequireRoles, StaffGuard } from '../staff/staff';
import { LOG_RETENTION_DAYS } from './log-store';

const SEVERITIES: Severity[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const SERVICES = ['api'];
/** Doc 17 initial limits: a log query covers at most 24 hours. */
const MAX_WINDOW_MS = 24 * 3600 * 1000;
const DEFAULT_WINDOW_MS = 3600 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface LogQuery {
  from: Date;
  to: Date;
  severity: Severity[];
  service?: string;
  build?: string;
  eventCode?: string;
  requestId?: string;
  traceId?: string;
  errorCode?: string;
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
  traceId: string | null;
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

/** Parses and bounds a log search: at most a 24-hour window inside the retention period, 50 rows a page by default and at most 100. */
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
  const limit = limitRaw ? Number(limitRaw) : DEFAULT_LIMIT;
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
    traceId: text(q, 'traceId', /^[0-9a-f]{32}$/),
    // Our own codes (IDP_DELETE_FAILED), and the driver's for unhandled errors (23505, ECONNREFUSED).
    errorCode: text(q, 'errorCode', /^[A-Za-z0-9_.-]{1,64}$/),
    status: statusRaw ? Number(statusRaw) : undefined,
    limit,
    cursor,
  };
}

type LogDbRow = {
  id: string;
  logged_at: Date;
  severity: Severity;
  service: string;
  environment: string;
  build: string;
  event_code: string;
  request_id: string | null;
  trace_id: string | null;
  method: string | null;
  route: string | null;
  status: number | null;
  duration_ms: number | null;
  actor_id: string | null;
  error_name: string | null;
  error_code: string | null;
};

const filtersOf = (q: LogQuery) => ({
  from: q.from.toISOString(),
  to: q.to.toISOString(),
  ...(q.severity.length && { severity: q.severity }),
  ...(q.service && { service: q.service }),
  ...(q.build && { build: q.build }),
  ...(q.eventCode && { eventCode: q.eventCode }),
  ...(q.requestId && { requestId: q.requestId }),
  ...(q.traceId && { traceId: q.traceId }),
  ...(q.errorCode && { errorCode: q.errorCode }),
  ...(q.status && { status: q.status }),
});

@Injectable()
export class LogsService {
  constructor(private readonly db: Database) {}

  /** Runs a search and records who searched for what in the audit trail, in one transaction. */
  async search(actor: { userId: string; requestId: string }, q: LogQuery): Promise<{ logs: LogRow[]; nextCursor: string | null; retentionDays: number }> {
    return this.db.transaction(async (query) => {
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: 'logs.search',
        targetType: 'operational_logs',
        targetId: '*',
        changes: { ...filtersOf(q), ...(q.cursor && { page: 'next' }) },
        requestId: actor.requestId,
      });
      const rows = await this.select(query, q, q.limit + 1);
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        logs: page,
        nextCursor: rows.length > q.limit ? Buffer.from(`${last.timestamp}|${last.id}`).toString('base64url') : null,
        retentionDays: LOG_RETENTION_DAYS,
      };
    });
  }

  /**
   * Doc 17 log export: up to 10,000 lines of the same search as CSV, newest first. The stated reason, the
   * filters and the row count are audited in the same transaction (never the lines themselves). A search
   * matching more lines is refused so it can be narrowed.
   */
  async export(actor: { userId: string; requestId: string }, q: LogQuery, reason: string): Promise<{ csv: string; rows: number }> {
    return this.db.transaction(async (query) => {
      const rows = await this.select(query, { ...q, cursor: undefined }, EXPORT_MAX_ROWS + 1);
      if (rows.length > EXPORT_MAX_ROWS) throw bad('from', 'too_many_rows');
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: 'logs.export',
        targetType: 'operational_logs',
        targetId: '*',
        reason,
        changes: { ...filtersOf(q), rows: rows.length },
        requestId: actor.requestId,
      });
      return { csv: toCsv(rows), rows: rows.length };
    });
  }

  private async select(query: Database['query'], q: LogQuery, limit: number): Promise<LogRow[]> {
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
    if (q.traceId) add('trace_id = ?', q.traceId);
    if (q.errorCode) add('error_code = ?', q.errorCode);
    if (q.status) add('status = ?', q.status);
    if (q.cursor) {
      params.push(q.cursor.at, q.cursor.id);
      where.push(`(logged_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
    }
    params.push(limit);
    const rows = await query<LogDbRow>(
      `SELECT id::text, logged_at, severity, service, environment, build, event_code, request_id, trace_id, method, route, status, duration_ms, actor_id, error_name, error_code
         FROM operational_logs WHERE ${where.join(' AND ')}
        ORDER BY logged_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      timestamp: r.logged_at.toISOString(),
      severity: r.severity,
      service: r.service,
      environment: r.environment,
      build: r.build,
      eventCode: r.event_code,
      requestId: r.request_id,
      traceId: r.trace_id,
      method: r.method,
      route: r.route,
      status: r.status,
      durationMs: r.duration_ms,
      actorId: r.actor_id,
      errorName: r.error_name,
      errorCode: r.error_code,
    }));
  }
}

const CSV_COLUMNS = ['id', 'timestamp', 'severity', 'service', 'environment', 'build', 'eventCode', 'requestId', 'traceId', 'method', 'route', 'status', 'durationMs', 'actorId', 'errorName', 'errorCode'] as const;

/** RFC 4180 CSV with a UTF-8 BOM, cells escaped like the audit export. */
export function toCsv(rows: LogRow[]): string {
  const lines = [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(','))];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** Staff log search and export (Doc 17 /admin/logs): operators and admins, bounded filters, every search and export audited. */
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

  /** CSV download of the same search (query string), with `{ reason }` in the body and MFA in the last 5 minutes. */
  @Post('export')
  @HttpCode(HttpStatus.OK)
  async export(@Req() req: Request, @Query() q: Record<string, unknown>, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const query = parseLogQuery(q);
    const reason = parseExportReason(body);
    requireRecentMfa(req);
    const { csv } = await this.logs.export({ userId: req.actor!.userId, requestId: req.requestId }, query, reason);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tunedeck-logs-${new Date().toISOString().slice(0, 10)}.csv"`);
    return csv;
  }
}
