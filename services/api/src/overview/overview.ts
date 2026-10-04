import { Controller, Get, HttpStatus, Inject, Injectable, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { DELETION_DEADLINE_DAYS } from '../account/account';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, AppConfig } from '../config';
import { Database } from '../db/database';
import { RequireRoles, StaffGuard } from '../staff/staff';
import { StationHealthService } from '../stations/station-health';
import { AlertService } from './alerts';

/** Doc 17 /admin/overview windows. Each bucket is one bar in the chart. */
export const WINDOWS = {
  '1h': { ms: 3600_000, bucket: '5 minutes', bucketMs: 300_000 },
  '24h': { ms: 24 * 3600_000, bucket: '1 hour', bucketMs: 3600_000 },
  '7d': { ms: 7 * 24 * 3600_000, bucket: '6 hours', bucketMs: 6 * 3600_000 },
} as const;
export type WindowId = keyof typeof WINDOWS;

/** Below this many requests an error rate says little, so no incident is raised from it. */
export const MIN_SAMPLE = 50;
export const ERROR_RATE_ALERT = 0.05;
/** No request logged for this long reads as "stale": the numbers may not describe now. */
const STALE_AFTER_MS = 15 * 60_000;
/** Warn before the 30-day deletion deadline, not on it. */
const DELETION_WARN_DAYS = 25;

export type IncidentCode =
  | 'api_error_rate'
  | 'api_latency'
  | 'stations_suspect'
  | 'station_checker_stale'
  | 'account_deletion_failed'
  | 'account_deletion_stuck'
  | 'account_deletion_late'
  | 'account_export_stuck'
  | 'idp_session_end_stuck'
  | 'job_dead_letter'
  | 'no_recent_traffic';

export interface Incident {
  code: IncidentCode;
  severity: 'critical' | 'warning';
  /** How many things are affected (stations, requests, deletions; p95 milliseconds for api_latency); meaning depends on code. */
  count: number;
  /** Set when the incident is an open alert (Doc 17 rules, evaluated every minute): when it started. */
  since?: string;
}

export interface Overview {
  window: { id: WindowId; from: string; to: string };
  generatedAt: string;
  api: {
    requests: number;
    serverErrors: number;
    clientErrors: number;
    errorRate: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    lastRequestAt: string | null;
    stale: boolean;
    buckets: { at: string; requests: number; serverErrors: number; p95Ms: number | null }[];
    topErrors: { route: string; status: number; count: number }[];
  };
  stations: {
    published: number;
    disabled: number;
    health: Record<'ok' | 'failing' | 'suspect' | 'unknown', number>;
    checkerEnabled: boolean;
    lastCheckAt: string | null;
  };
  queues: {
    accountDeletions: { open: number; failed: number; oldestRequestedAt: string | null; deadlineDays: number };
    diagnosticReports: number;
  };
  incidents: Incident[];
}

export function parseWindow(q: Record<string, unknown>): WindowId {
  const w = q.window ?? '24h';
  if (typeof w !== 'string' || !(w in WINDOWS)) throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field: 'window', reason: 'invalid' });
  return w as WindowId;
}

/**
 * Operations overview: API traffic and errors from the stored request logs, catalog health, and the
 * background queues, for one time window. Every number comes with its sample size or a stale flag,
 * so a quiet hour is not mistaken for a healthy one. Aggregates only: no user, request or station ids.
 */
@Injectable()
export class OverviewService {
  constructor(
    private readonly db: Database,
    private readonly health: StationHealthService,
    private readonly alerts: AlertService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async load(windowId: WindowId, now = new Date()): Promise<Overview> {
    const w = WINDOWS[windowId];
    const from = new Date(now.getTime() - w.ms);
    const range = [from.toISOString(), now.toISOString()];
    const requests = `FROM operational_logs WHERE event_code = 'HTTP_REQUEST' AND logged_at >= $1 AND logged_at < $2`;

    const [[totals], buckets, topErrors, [last], stationRows, [deletions], [diag], [lastCheck], openAlerts] = await Promise.all([
      this.db.query<{ n: string; s5: string; s4: string; p50: number | null; p95: number | null }>(
        `SELECT count(*) AS n, count(*) FILTER (WHERE status >= 500) AS s5, count(*) FILTER (WHERE status >= 400 AND status < 500) AS s4,
                percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
                percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95 ${requests}`,
        range,
      ),
      this.db.query<{ at: Date; n: string; s5: string; p95: number | null }>(
        `SELECT date_bin($3::interval, logged_at, $1::timestamptz) AS at, count(*) AS n, count(*) FILTER (WHERE status >= 500) AS s5,
                percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95
           ${requests} GROUP BY 1 ORDER BY 1`,
        [...range, w.bucket],
      ),
      this.db.query<{ route: string; status: number; n: string }>(
        `SELECT route, status, count(*) AS n ${requests} AND status >= 500 GROUP BY route, status ORDER BY n DESC, route LIMIT 5`,
        range,
      ),
      this.db.query<{ at: Date | null }>(`SELECT max(logged_at) AS at FROM operational_logs WHERE event_code = 'HTTP_REQUEST'`),
      this.db.query<{ id: string; disabled: boolean }>(
        `SELECT id, disabled_at IS NOT NULL AS disabled FROM radio_stations WHERE published IS NOT NULL`,
      ),
      this.db.query<{ open: string; failed: string; oldest: Date | null }>(
        `SELECT count(*) AS open, count(*) FILTER (WHERE status IN ('failed', 'dead_letter')) AS failed, min(requested_at) AS oldest
           FROM account_deletions WHERE status <> 'completed'`,
      ),
      this.db.query<{ n: string }>(`SELECT count(*) AS n FROM diagnostic_reports WHERE received_at >= $1 AND received_at < $2`, range),
      this.db.query<{ at: Date | null }>(`SELECT max(checked_at) AS at FROM station_health WHERE target = 'published'`),
      this.alerts.open(),
    ]);

    const live = stationRows.filter((s) => !s.disabled).map((s) => s.id);
    const summaries = await this.health.summaries(live);
    const health = { ok: 0, failing: 0, suspect: 0, unknown: 0 };
    for (const id of live) health[summaries.get(id)?.state ?? 'unknown']++;

    const n = Number(totals.n);
    const s5 = Number(totals.s5);
    const lastAt = last?.at ?? null;
    const stale = !lastAt || now.getTime() - lastAt.getTime() > STALE_AFTER_MS;
    const checkerEnabled = this.config.stationCheck.enabled;
    const checkerLate =
      checkerEnabled && live.length > 0 && (!lastCheck?.at || now.getTime() - lastCheck.at.getTime() > 2.5 * this.config.stationCheck.intervalMinutes * 60_000);
    const oldest = deletions.oldest;

    const incidents: Incident[] = [];
    if (n >= MIN_SAMPLE && s5 / n >= ERROR_RATE_ALERT) incidents.push({ code: 'api_error_rate', severity: 'critical', count: s5 });
    if (Number(deletions.failed) > 0) incidents.push({ code: 'account_deletion_failed', severity: 'critical', count: Number(deletions.failed) });
    if (oldest && now.getTime() - oldest.getTime() > DELETION_WARN_DAYS * 86_400_000) {
      incidents.push({ code: 'account_deletion_late', severity: 'critical', count: Number(deletions.open) });
    }
    if (health.suspect > 0) incidents.push({ code: 'stations_suspect', severity: 'warning', count: health.suspect });
    if (checkerLate) incidents.push({ code: 'station_checker_stale', severity: 'warning', count: live.length });
    if (stale) incidents.push({ code: 'no_recent_traffic', severity: 'warning', count: 0 });
    // Open alerts are about now, whatever window is shown; the window's own findings above take precedence.
    for (const a of openAlerts) {
      const existing = incidents.find((i) => i.code === a.code);
      if (existing) existing.since = a.firedAt;
      else incidents.push({ code: a.code, severity: a.severity, count: a.code === 'api_error_rate' ? Math.round((a.value ?? 0) * (a.sample ?? 0)) : Math.round(a.value ?? 0), since: a.firedAt });
    }

    return {
      window: { id: windowId, from: from.toISOString(), to: now.toISOString() },
      generatedAt: now.toISOString(),
      api: {
        requests: n,
        serverErrors: s5,
        clientErrors: Number(totals.s4),
        errorRate: n > 0 ? s5 / n : null,
        p50Ms: totals.p50,
        p95Ms: totals.p95,
        lastRequestAt: lastAt?.toISOString() ?? null,
        stale,
        buckets: fillBuckets(from, now, w.bucketMs, buckets),
        topErrors: topErrors.map((e) => ({ route: e.route, status: e.status, count: Number(e.n) })),
      },
      stations: {
        published: live.length,
        disabled: stationRows.length - live.length,
        health,
        checkerEnabled,
        lastCheckAt: lastCheck?.at?.toISOString() ?? null,
      },
      queues: {
        accountDeletions: { open: Number(deletions.open), failed: Number(deletions.failed), oldestRequestedAt: oldest?.toISOString() ?? null, deadlineDays: DELETION_DEADLINE_DAYS },
        diagnosticReports: Number(diag.n),
      },
      incidents,
    };
  }
}

/** Every bucket in the window, empty ones included, so the chart's gaps are visible as zero, not skipped. */
function fillBuckets(from: Date, to: Date, bucketMs: number, rows: { at: Date; n: string; s5: string; p95: number | null }[]) {
  const byStart = new Map(rows.map((r) => [r.at.getTime(), r]));
  const out: Overview['api']['buckets'] = [];
  for (let t = from.getTime(); t < to.getTime(); t += bucketMs) {
    const r = byStart.get(t);
    out.push({ at: new Date(t).toISOString(), requests: Number(r?.n ?? 0), serverErrors: Number(r?.s5 ?? 0), p95Ms: r?.p95 ?? null });
  }
  return out;
}

@Controller('v1/admin/overview')
@UseGuards(AuthGuard, StaffGuard)
@RequireRoles('operator', 'admin')
export class AdminOverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get()
  async get(@Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response): Promise<Overview> {
    res.setHeader('Cache-Control', 'no-store');
    return this.overview.load(parseWindow(q));
  }
}
