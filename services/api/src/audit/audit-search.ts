import { Body, Controller, Get, HttpCode, HttpStatus, Injectable, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { Database } from '../db/database';
import { RequireRoles, StaffGuard } from '../staff/staff';
import { writeAudit } from './audit';

const MAX_WINDOW_MS = 90 * 24 * 3600 * 1000;
const DEFAULT_WINDOW_MS = 7 * 24 * 3600 * 1000;
const MAX_LIMIT = 200;
/** Searching logs or the audit trail is itself recorded; these rows are hidden unless asked for. */
const READ_ACTIONS = ['logs.search', 'audit.search'];
/** Doc 17: exports hold at most 10k rows per job. */
export const EXPORT_MAX_ROWS = 10_000;

export interface AuditQuery {
  from: Date;
  to: Date;
  actor?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  requestId?: string;
  includeReads: boolean;
  limit: number;
  cursor?: { at: string; id: string };
}

export interface AuditRow {
  id: string;
  occurredAt: string;
  actor: string;
  /** OIDC subject of a `user:` actor, so staff can tell who it was without an email address. */
  actorSubject: string | null;
  action: string;
  /** Readable name of the target when it still exists: station name or account subject. */
  targetLabel: string | null;
  targetType: string;
  targetId: string;
  reason: string | null;
  changes: Record<string, unknown>;
  requestId: string | null;
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

/** Parses and bounds an audit search: a window of at most 90 days (default 7), at most 200 rows a page. */
export function parseAuditQuery(q: Record<string, unknown>, now = new Date()): AuditQuery {
  const to = time(q, 'to') ?? now;
  const from = time(q, 'from') ?? new Date(to.getTime() - DEFAULT_WINDOW_MS);
  if (from >= to) throw bad('from', 'after_to');
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) throw bad('from', 'window_too_long');
  const limitRaw = text(q, 'limit', /^\d{1,3}$/);
  const limit = limitRaw ? Number(limitRaw) : 50;
  if (limit < 1 || limit > MAX_LIMIT) throw bad('limit');
  const cursorRaw = text(q, 'cursor', /^[A-Za-z0-9_-]{1,120}$/);
  let cursor: AuditQuery['cursor'];
  if (cursorRaw) {
    const [at, id] = Buffer.from(cursorRaw, 'base64url').toString().split('|');
    if (!at || !/^\d{1,19}$/.test(id ?? '') || Number.isNaN(new Date(at).getTime())) throw bad('cursor', 'malformed');
    cursor = { at, id };
  }
  const reads = text(q, 'includeReads', /^(0|1|true|false)$/);
  return {
    from,
    to,
    // A user's OIDC subject, or `operator:<label>` for the staff CLI.
    actor: text(q, 'actor', /^[A-Za-z0-9._:@|-]{1,128}$/),
    action: text(q, 'action', /^[a-z_]{1,40}(\.[a-z_]{1,40})?$/),
    targetType: text(q, 'targetType', /^[a-z_]{1,40}$/),
    targetId: text(q, 'targetId', /^[A-Za-z0-9._*-]{1,64}$/),
    requestId: text(q, 'requestId', /^[A-Za-z0-9._-]{8,64}$/),
    includeReads: reads === '1' || reads === 'true',
    limit,
    cursor,
  };
}

@Injectable()
export class AuditSearchService {
  constructor(private readonly db: Database) {}

  /** Reads the audit trail and records the read itself (Doc 17: privileged access logged), in one transaction. */
  async search(actor: { userId: string; requestId: string }, q: AuditQuery): Promise<{ events: AuditRow[]; nextCursor: string | null }> {
    return this.db.transaction(async (query) => {
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: 'audit.search',
        targetType: 'audit_events',
        targetId: '*',
        changes: { ...filtersOf(q), ...(q.cursor && { page: 'next' }) },
        requestId: actor.requestId,
      });
      const rows = await this.select(query, q, q.limit + 1);
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        events: page,
        nextCursor: rows.length > q.limit ? Buffer.from(`${last.occurredAt}|${last.id}`).toString('base64url') : null,
      };
    });
  }

  /**
   * Doc 17 audit export: up to 10,000 rows as CSV, with a stated reason that is itself audited (with the filters
   * and row count) in the same transaction. A search matching more rows is refused so it can be narrowed.
   */
  async export(actor: { userId: string; requestId: string }, q: AuditQuery, reason: string): Promise<{ csv: string; rows: number }> {
    return this.db.transaction(async (query) => {
      const rows = await this.select(query, { ...q, cursor: undefined }, EXPORT_MAX_ROWS + 1);
      if (rows.length > EXPORT_MAX_ROWS) throw bad('from', 'too_many_rows');
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: 'audit.export',
        targetType: 'audit_events',
        targetId: '*',
        reason,
        changes: { ...filtersOf(q), rows: rows.length },
        requestId: actor.requestId,
      });
      return { csv: toCsv(rows), rows: rows.length };
    });
  }

  private async select(query: Database['query'], q: AuditQuery, limit: number): Promise<AuditRow[]> {
    const where = ['a.occurred_at >= $1', 'a.occurred_at < $2'];
    const params: unknown[] = [q.from.toISOString(), q.to.toISOString()];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replaceAll('?', `$${params.length}`));
    };
    if (q.actor) {
      if (q.actor.startsWith('operator:')) add('a.actor = ?', q.actor);
      else add(`(a.actor = 'user:' || (SELECT id::text FROM users WHERE oidc_subject = ?) OR a.actor = 'user:' || ?)`, q.actor);
    }
    if (q.action) add(q.action.includes('.') ? 'a.action = ?' : `split_part(a.action, '.', 1) = ?`, q.action);
    if (q.targetType) add('a.target_type = ?', q.targetType);
    if (q.targetId) add('a.target_id = ?', q.targetId);
    if (q.requestId) add('a.request_id = ?', q.requestId);
    if (!q.includeReads) add('NOT (a.action = ANY(?))', READ_ACTIONS);
    if (q.cursor) {
      params.push(q.cursor.at, q.cursor.id);
      where.push(`(a.occurred_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
    }
    params.push(limit);
    const rows = await query<{
        id: string;
        occurred_at: Date;
        actor: string;
        actor_subject: string | null;
        target_label: string | null;
        action: string;
        target_type: string;
        target_id: string;
        reason: string | null;
        changes: Record<string, unknown>;
        request_id: string | null;
      }>(
        `SELECT a.id::text, a.occurred_at, a.actor, u.oidc_subject AS actor_subject,
                CASE a.target_type WHEN 'station' THEN st.draft->>'name' WHEN 'user' THEN tu.oidc_subject END AS target_label, a.action, a.target_type, a.target_id, a.reason, a.changes, a.request_id
           FROM audit_events a
           LEFT JOIN users u ON a.actor LIKE 'user:%' AND u.id::text = substr(a.actor, 6)
           LEFT JOIN radio_stations st ON a.target_type = 'station' AND st.id::text = a.target_id
           LEFT JOIN users tu ON a.target_type = 'user' AND tu.id::text = a.target_id
          WHERE ${where.join(' AND ')}
          ORDER BY a.occurred_at DESC, a.id DESC LIMIT $${params.length}`,
        params,
      );
    return rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at.toISOString(),
      actor: r.actor,
      actorSubject: r.actor_subject,
      action: r.action,
      targetLabel: r.target_label,
      targetType: r.target_type,
      targetId: r.target_id,
      reason: r.reason,
      changes: r.changes,
      requestId: r.request_id,
    }));
  }
}

const filtersOf = (q: AuditQuery) => ({
  from: q.from.toISOString(),
  to: q.to.toISOString(),
  ...(q.actor && { actor: q.actor }),
  ...(q.action && { action: q.action }),
  ...(q.targetType && { targetType: q.targetType }),
  ...(q.targetId && { targetId: q.targetId }),
  ...(q.requestId && { requestId: q.requestId }),
  ...(q.includeReads && { includeReads: true }),
});

const CSV_COLUMNS = ['id', 'occurredAt', 'actor', 'actorSubject', 'action', 'targetType', 'targetId', 'targetLabel', 'reason', 'changes', 'requestId'] as const;

/** One CSV cell. Text a spreadsheet would run as a formula (= + - @, tab, CR) gets a leading apostrophe. */
function cell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** RFC 4180 CSV with a UTF-8 BOM so Excel shows Thai text correctly. */
export function toCsv(rows: AuditRow[]): string {
  const lines = [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => cell(r[c])).join(','))];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** The export reason: 10 to 500 characters of plain text, no control characters. */
export function parseExportReason(body: unknown): string {
  const reason = typeof body === 'object' && body !== null ? (body as { reason?: unknown }).reason : undefined;
  if (typeof reason !== 'string') throw bad('reason', 'required');
  const r = reason.trim();
  if (r.length < 10 || r.length > 500) throw bad('reason', 'length');
  if (/[\u0000-\u001f\u007f]/.test(r)) throw bad('reason', 'control_characters');
  return r;
}

/** Staff audit trail (Doc 17 /admin/audit): auditors and admins read; every read is itself audited. */
@Controller('v1/admin/audit')
@UseGuards(AuthGuard, StaffGuard)
@RequireRoles('auditor', 'admin')
export class AdminAuditController {
  constructor(private readonly audit: AuditSearchService) {}

  @Get()
  async search(@Req() req: Request, @Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.audit.search({ userId: req.actor!.userId, requestId: req.requestId }, parseAuditQuery(q));
  }

  /** CSV download of the same search (query string), with `{ reason }` in the body. POST because it is recorded. */
  @Post('export')
  @HttpCode(HttpStatus.OK)
  async export(@Req() req: Request, @Query() q: Record<string, unknown>, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const query = parseAuditQuery(q);
    const reason = parseExportReason(body);
    const { csv } = await this.audit.export({ userId: req.actor!.userId, requestId: req.requestId }, query, reason);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tunedeck-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    return csv;
  }
}

