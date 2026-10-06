import {
  Body,
  Controller,
  Delete,
  Get,
  Query,
  HttpCode,
  HttpStatus,
  Injectable,
  OnApplicationShutdown,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { decodeCursor, encodeCursor, PAGE_MAX, parseLimit } from '../common/pagination';
import { Database } from '../db/database';

/** Doc 07 allowed event names. Anything else is refused, so new kinds of data need a code change and review. */
export const EVENT_NAMES = [
  'import_completed',
  'import_failed',
  'playback_start_result',
  'playback_stall',
  'playback_recovered',
  'app_error',
  'purchase_result',
  'carplay_session_result',
] as const;
/** Doc 17 initial limits: ≤100 events / 128 KiB per batch, ≤10 batches a minute per device. */
export const LIMITS = { eventsPerBatch: 100, batchBytes: 128 * 1024, batchesPerMinutePerDevice: 10 };
export const DIAGNOSTICS_RETENTION_DAYS = 7;
const PRUNE_EVERY_MS = 60 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUILD = /^[0-9A-Za-z.+-]{1,32}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** Stable error-catalog style codes (Doc 07), e.g. MEDIA_STALLED. Free text is never accepted. */
const RESULT_CODE = /^[A-Z][A-Z0-9_]{1,47}$/;
const BATCH_FIELDS = ['batchId', 'deviceId', 'consent', 'events'];
const EVENT_FIELDS = [
  'eventId',
  'eventName',
  'schemaVersion',
  'monotonicMs',
  'sessionRandomId',
  'durationMs',
  'resultCode',
  'networkClass',
  'appBuild',
  'osMajor',
  'deviceClass',
];

export interface DiagnosticEvent {
  eventId: string;
  eventName: (typeof EVENT_NAMES)[number];
  schemaVersion: 1;
  monotonicMs: number;
  sessionRandomId: string;
  durationMs: number | null;
  resultCode: string | null;
  networkClass: 'wifi' | 'cellular' | 'offline';
  appBuild: string;
  osMajor: number;
  deviceClass: 'phone' | 'tablet';
}

export interface DiagnosticBatch {
  batchId: string;
  deviceId: string;
  events: DiagnosticEvent[];
}

const invalid = (field: string, reason: string) => new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field, reason });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const intIn = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;

function parseEvent(v: unknown, i: number): DiagnosticEvent {
  const at = (f: string) => `events[${i}].${f}`;
  if (!isObject(v)) throw invalid(`events[${i}]`, 'must_be_object');
  // Unknown fields are refused rather than dropped, so nothing outside the schema (a URL, a title) can ride along.
  for (const key of Object.keys(v)) if (!EVENT_FIELDS.includes(key)) throw invalid(at(key), 'unknown_field');
  if (typeof v.eventId !== 'string' || !UUID.test(v.eventId)) throw invalid(at('eventId'), 'must_be_uuid');
  if (typeof v.eventName !== 'string' || !(EVENT_NAMES as readonly string[]).includes(v.eventName)) throw invalid(at('eventName'), 'value_not_allowed');
  if (v.schemaVersion !== 1) throw invalid(at('schemaVersion'), 'unsupported');
  if (!intIn(v.monotonicMs, 0, Number.MAX_SAFE_INTEGER)) throw invalid(at('monotonicMs'), 'out_of_range');
  if (typeof v.sessionRandomId !== 'string' || !SESSION_ID.test(v.sessionRandomId)) throw invalid(at('sessionRandomId'), 'malformed');
  if (v.durationMs !== undefined && v.durationMs !== null && !intIn(v.durationMs, 0, 86_400_000)) throw invalid(at('durationMs'), 'out_of_range');
  if (v.resultCode !== undefined && v.resultCode !== null && (typeof v.resultCode !== 'string' || !RESULT_CODE.test(v.resultCode))) {
    throw invalid(at('resultCode'), 'malformed');
  }
  if (!['wifi', 'cellular', 'offline'].includes(v.networkClass as string)) throw invalid(at('networkClass'), 'value_not_allowed');
  if (typeof v.appBuild !== 'string' || !BUILD.test(v.appBuild)) throw invalid(at('appBuild'), 'malformed');
  if (!intIn(v.osMajor, 0, 99)) throw invalid(at('osMajor'), 'out_of_range');
  if (!['phone', 'tablet'].includes(v.deviceClass as string)) throw invalid(at('deviceClass'), 'value_not_allowed');
  return {
    eventId: v.eventId.toLowerCase(),
    eventName: v.eventName as DiagnosticEvent['eventName'],
    schemaVersion: 1,
    monotonicMs: v.monotonicMs as number,
    sessionRandomId: v.sessionRandomId,
    durationMs: (v.durationMs as number | undefined) ?? null,
    resultCode: (v.resultCode as string | undefined) ?? null,
    networkClass: v.networkClass as DiagnosticEvent['networkClass'],
    appBuild: v.appBuild,
    osMajor: v.osMajor as number,
    deviceClass: v.deviceClass as DiagnosticEvent['deviceClass'],
  };
}

/** Validates an upload. The device must say the user agreed to this upload (`consent: true`). */
export function parseBatch(body: unknown): DiagnosticBatch {
  if (!isObject(body)) throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { reason: 'body_must_be_object' });
  for (const key of Object.keys(body)) if (!BATCH_FIELDS.includes(key)) throw invalid(key, 'unknown_field');
  if (body.consent !== true) throw invalid('consent', 'consent_required');
  if (typeof body.batchId !== 'string' || !UUID.test(body.batchId)) throw invalid('batchId', 'must_be_uuid');
  if (typeof body.deviceId !== 'string' || !UUID.test(body.deviceId)) throw invalid('deviceId', 'must_be_uuid');
  if (!Array.isArray(body.events) || body.events.length === 0) throw invalid('events', 'must_be_non_empty_array');
  if (body.events.length > LIMITS.eventsPerBatch) throw invalid('events', 'too_many');
  const events = body.events.map(parseEvent);
  if (new Set(events.map((e) => e.eventId)).size !== events.length) throw invalid('events', 'duplicate_event_id');
  return { batchId: body.batchId.toLowerCase(), deviceId: body.deviceId.toLowerCase(), events };
}

export function parseReportId(id: string): string {
  if (!UUID.test(id)) throw invalid('id', 'must_be_uuid');
  return id.toLowerCase();
}

export interface UploadResult {
  reportId: string;
  accepted: number;
  duplicates: number;
}

export interface ReportSummary {
  id: string;
  receivedAt: string;
  expiresAt: string;
  deviceId: string;
  platform: string | null;
  eventCount: number;
  events: { eventName: string; count: number }[];
}

const COLUMNS = 13;

@Injectable()
export class DiagnosticsService implements OnApplicationShutdown {
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly db: Database) {
    this.timer = setInterval(() => void this.prune().catch(() => undefined), PRUNE_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /**
   * Stores one batch. A batch sent again (same batchId) returns the first result; events already
   * stored under the same eventId are skipped, so retries from the app are always safe.
   */
  async upload(ownerId: string, batch: DiagnosticBatch): Promise<{ result: UploadResult } | { retryAfter: number }> {
    return this.db.transaction(async (query) => {
      const [device] = await query<{ revoked_at: Date | null; recent: string }>(
        `SELECT revoked_at,
                (SELECT count(*) FROM diagnostic_reports r
                  WHERE r.user_id = d.user_id AND r.device_id = d.id AND r.received_at > now() - interval '1 minute') AS recent
           FROM devices d WHERE user_id = $1 AND id = $2 FOR UPDATE`,
        [ownerId, batch.deviceId],
      );
      if (!device) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', { field: 'deviceId', reason: 'device_not_registered' });
      if (device.revoked_at) throw new ApiError(HttpStatus.FORBIDDEN, 'DEVICE_REVOKED');

      const [prior] = await query<{ id: string; event_count: number }>(
        'SELECT id, event_count FROM diagnostic_reports WHERE user_id = $1 AND batch_id = $2',
        [ownerId, batch.batchId],
      );
      if (prior) return { result: { reportId: prior.id, accepted: 0, duplicates: batch.events.length } };
      if (Number(device.recent) >= LIMITS.batchesPerMinutePerDevice) return { retryAfter: 60 };

      // The device lock above serialises one device; the same batchId sent from two devices at once lands here.
      const [report] = await query<{ id: string }>(
        `INSERT INTO diagnostic_reports (user_id, device_id, batch_id, consented, event_count) VALUES ($1, $2, $3, true, 0)
         ON CONFLICT (user_id, batch_id) DO NOTHING RETURNING id`,
        [ownerId, batch.deviceId, batch.batchId],
      );
      if (!report) {
        const [first] = await query<{ id: string }>('SELECT id FROM diagnostic_reports WHERE user_id = $1 AND batch_id = $2', [ownerId, batch.batchId]);
        return { result: { reportId: first.id, accepted: 0, duplicates: batch.events.length } };
      }
      const params: unknown[] = [];
      const rows = batch.events.map((e, i) => {
        params.push(report.id, ownerId, e.eventId, e.eventName, e.schemaVersion, e.monotonicMs, e.sessionRandomId, e.durationMs, e.resultCode, e.networkClass, e.appBuild, e.osMajor, e.deviceClass);
        return `(${Array.from({ length: COLUMNS }, (_, j) => `$${i * COLUMNS + j + 1}`).join(', ')})`;
      });
      const inserted = await query<{ event_id: string }>(
        `INSERT INTO diagnostic_events (report_id, user_id, event_id, event_name, schema_version, monotonic_ms, session_random_id,
                                        duration_ms, result_code, network_class, app_build, os_major, device_class)
         VALUES ${rows.join(', ')} ON CONFLICT (user_id, event_id) DO NOTHING RETURNING event_id`,
        params,
      );
      await query('UPDATE diagnostic_reports SET event_count = $2 WHERE id = $1', [report.id, inserted.length]);
      return { result: { reportId: report.id, accepted: inserted.length, duplicates: batch.events.length - inserted.length } };
    });
  }

  /** Newest first, one page (Doc 17: cursor pages of at most 100); `only` picks a single report. */
  async list(ownerId: string, opts: { after?: string[] | null; limit?: number; only?: string } = {}): Promise<ReportSummary[]> {
    const limit = opts.limit ?? PAGE_MAX;
    const params: unknown[] = [ownerId, DIAGNOSTICS_RETENTION_DAYS, limit];
    let extra = '';
    if (opts.only) {
      params.push(opts.only);
      extra = ` AND r.id = $${params.length}`;
    } else if (opts.after) {
      if (Number.isNaN(Date.parse(opts.after[0])) || !/^[0-9a-f-]{36}$/.test(opts.after[1])) {
        throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field: 'cursor', reason: 'malformed' });
      }
      params.push(opts.after[0], opts.after[1]);
      extra = ` AND (date_trunc('milliseconds', r.received_at), r.id::text) < ($${params.length - 1}::timestamptz, $${params.length})`;
    }
    const rows = await this.db.query<{
      id: string;
      received_at: Date;
      device_id: string;
      platform: string | null;
      event_count: number;
      events: { eventName: string; count: number }[] | null;
    }>(
      `SELECT r.id, r.received_at, r.device_id, d.platform, r.event_count,
              (SELECT json_agg(json_build_object('eventName', event_name, 'count', n) ORDER BY n DESC, event_name)
                 FROM (SELECT event_name, count(*)::int AS n FROM diagnostic_events e WHERE e.report_id = r.id GROUP BY event_name) c) AS events
         FROM diagnostic_reports r LEFT JOIN devices d ON d.user_id = r.user_id AND d.id = r.device_id
        WHERE r.user_id = $1 AND r.received_at > now() - make_interval(days => $2)${extra}
        ORDER BY date_trunc('milliseconds', r.received_at) DESC, r.id::text DESC LIMIT $3`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      receivedAt: r.received_at.toISOString(),
      expiresAt: new Date(r.received_at.getTime() + DIAGNOSTICS_RETENTION_DAYS * 86_400_000).toISOString(),
      deviceId: r.device_id,
      platform: r.platform,
      eventCount: r.event_count,
      events: r.events ?? [],
    }));
  }

  /** One report with its events, for the owner to see exactly what was sent. */
  async get(ownerId: string, id: string): Promise<ReportSummary & { items: DiagnosticEvent[] }> {
    const [summary] = await this.list(ownerId, { only: id });
    if (!summary) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    const items = await this.db.query<Record<string, unknown>>(
      `SELECT event_id, event_name, schema_version, monotonic_ms, session_random_id, duration_ms, result_code,
              network_class, app_build, os_major, device_class
         FROM diagnostic_events WHERE report_id = $1 AND user_id = $2 ORDER BY monotonic_ms, event_id`,
      [id, ownerId],
    );
    return {
      ...summary,
      items: items.map((e) => ({
        eventId: e.event_id as string,
        eventName: e.event_name as DiagnosticEvent['eventName'],
        schemaVersion: 1,
        monotonicMs: Number(e.monotonic_ms),
        sessionRandomId: e.session_random_id as string,
        durationMs: e.duration_ms as number | null,
        resultCode: e.result_code as string | null,
        networkClass: e.network_class as DiagnosticEvent['networkClass'],
        appBuild: e.app_build as string,
        osMajor: e.os_major as number,
        deviceClass: e.device_class as DiagnosticEvent['deviceClass'],
      })),
    };
  }

  async delete(ownerId: string, id: string): Promise<void> {
    const rows = await this.db.query('DELETE FROM diagnostic_reports WHERE user_id = $1 AND id = $2 RETURNING id', [ownerId, id]);
    if (!rows.length) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
  }

  /** Doc 17 retention: client diagnostics 7 days. Events go with their report. */
  async prune(): Promise<number> {
    let total = 0;
    for (let i = 0; i < 50; i++) {
      const rows = await this.db.query(
        `DELETE FROM diagnostic_reports WHERE id IN (
           SELECT id FROM diagnostic_reports WHERE received_at < now() - make_interval(days => $1) LIMIT 1000) RETURNING id`,
        [DIAGNOSTICS_RETENTION_DAYS],
      );
      total += rows.length;
      if (rows.length < 1000) break;
    }
    // Support access: one-time codes are useless a day after they expire; grants are kept as long as the
    // reports they could open (the audit log keeps who was given access, and why).
    await this.db.query(`DELETE FROM support_access_codes WHERE expires_at < now() - interval '1 day'`);
    await this.db.query(
      `DELETE FROM support_access_grants WHERE coalesce(revoked_at, expires_at) < now() - make_interval(days => $1)`,
      [DIAGNOSTICS_RETENTION_DAYS],
    );
    return total;
  }
}

/** The phone app's opt-in upload (Doc 17 POST /diagnostics/batches). */
@Controller('v1/diagnostics')
@UseGuards(AuthGuard)
export class DiagnosticsUploadController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  @Post('batches')
  @HttpCode(HttpStatus.OK)
  async upload(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<UploadResult> {
    res.setHeader('Cache-Control', 'no-store');
    const out = await this.diagnostics.upload(req.actor!.userId, parseBatch(body));
    if ('retryAfter' in out) {
      res.setHeader('Retry-After', String(out.retryAfter));
      throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'API_RATE_LIMITED', { retryAfterSeconds: out.retryAfter, scope: 'device_batches' });
    }
    return out.result;
  }
}

/** The owner's own reports: list, view, delete (Doc 17 GET/DELETE /me/diagnostics). */
@Controller('v1/me/diagnostics')
@UseGuards(AuthGuard)
export class MyDiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  @Get()
  async list(@Req() req: Request, @Query('cursor') cursor: unknown, @Query('limit') limit: unknown, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const size = parseLimit(limit);
    const rows = await this.diagnostics.list(req.actor!.userId, { after: decodeCursor(cursor, 2), limit: size + 1 });
    const reports = rows.slice(0, size);
    const last = reports.at(-1);
    return {
      reports,
      nextCursor: rows.length > size && last ? encodeCursor([last.receivedAt, last.id]) : null,
      retentionDays: DIAGNOSTICS_RETENTION_DAYS,
    };
  }

  @Get(':id')
  async get(@Req() req: Request, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.diagnostics.get(req.actor!.userId, parseReportId(id));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Req() req: Request, @Param('id') id: string): Promise<void> {
    await this.diagnostics.delete(req.actor!.userId, parseReportId(id));
  }
}
