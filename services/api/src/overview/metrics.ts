import { Controller, Get, HttpStatus, Injectable, OnApplicationBootstrap, OnApplicationShutdown, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { Database } from '../db/database';
import { RequireRoles, StaffGuard } from '../staff/staff';

/** Doc 17: metrics are kept 90 days. */
export const METRICS_RETENTION_DAYS = 90;
/** Upper bounds of the latency buckets in ms; the last bucket is everything slower. */
export const LATENCY_BOUNDS_MS = [50, 100, 250, 500, 1000, 2500, 5000] as const;
const BUCKETS = { '1h': { ms: 3600_000, maxRangeDays: 14 }, '1d': { ms: 86_400_000, maxRangeDays: METRICS_RETENTION_DAYS } } as const;
type BucketId = keyof typeof BUCKETS;
const ROLLUP_EVERY_MS = 5 * 60_000;
/** A read refreshes the current hours first if the last rollup is older than this. */
const FRESH_MS = 60_000;
const TOP_ROUTES = 50;

export interface MetricsQuery {
  from: Date;
  to: Date;
  bucket: BucketId;
  method?: string;
  route?: string;
}

interface Counts {
  requests: number;
  serverErrors: number;
  clientErrors: number;
  /** 5xx share of requests; null without requests. */
  errorRate: number | null;
  /** Upper bound of the latency bucket holding the median / 95th percentile; null without requests or above 5000 ms. */
  p50UpToMs: number | null;
  p95UpToMs: number | null;
  latencyBuckets: number[];
}

export interface Metrics {
  from: string;
  to: string;
  bucket: BucketId;
  latencyBoundsMs: readonly number[];
  totals: Counts;
  series: Array<{ at: string } & Counts>;
  routes: Array<{ method: string; route: string } & Counts>;
  retentionDays: number;
}

const bad = (field: string, reason = 'invalid') => new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field, reason });

function str(q: Record<string, unknown>, field: string, pattern: RegExp): string | undefined {
  const v = q[field];
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !pattern.test(v)) throw bad(field);
  return v;
}

function time(q: Record<string, unknown>, field: string): Date | undefined {
  const v = str(q, field, /^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:\d{2})$/);
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw bad(field);
  return d;
}

/** Bounded filters: hourly points over at most 14 days, daily points over at most 90; default the last 24 hours by hour. */
export function parseMetricsQuery(q: Record<string, unknown>, now = new Date()): MetricsQuery {
  const bucket = (str(q, 'bucket', /^(1h|1d)$/) ?? '1h') as BucketId;
  const to = time(q, 'to') ?? now;
  const from = time(q, 'from') ?? new Date(to.getTime() - 86_400_000);
  if (from >= to) throw bad('from', 'after_to');
  if (to.getTime() - from.getTime() > BUCKETS[bucket].maxRangeDays * 86_400_000) throw bad('from', 'window_too_long');
  if (now.getTime() - from.getTime() > (METRICS_RETENTION_DAYS + 1) * 86_400_000) throw bad('from', 'past_retention');
  return {
    from,
    to,
    bucket,
    method: str(q, 'method', /^(GET|POST|PUT|PATCH|DELETE)$/),
    route: str(q, 'route', /^\/[A-Za-z0-9/:_-]{0,200}$/),
  };
}

export function percentileUpTo(buckets: number[], q: number): number | null {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    seen += buckets[i];
    if (seen >= q * total) return LATENCY_BOUNDS_MS[i] ?? null;
  }
  return null;
}

/** Sums arrive as strings, and as NULL over no rows. */
function counts(r: { requests: number | string | null; server_errors: number | string | null; client_errors: number | string | null; latency: (number | string | null)[] | null }): Counts {
  const requests = Number(r.requests);
  const serverErrors = Number(r.server_errors);
  const latencyBuckets = (r.latency ?? [0, 0, 0, 0, 0, 0, 0, 0]).map((x) => Number(x ?? 0));
  return {
    requests,
    serverErrors,
    clientErrors: Number(r.client_errors),
    errorRate: requests > 0 ? serverErrors / requests : null,
    p50UpToMs: percentileUpTo(latencyBuckets, 0.5),
    p95UpToMs: percentileUpTo(latencyBuckets, 0.95),
    latencyBuckets,
  };
}

// Sums the eight histogram slots across rows.
const SUM_LATENCY = `ARRAY[${Array.from({ length: 8 }, (_, i) => `SUM(latency_buckets[${i + 1}])`).join(', ')}]`;

/**
 * Doc 17 operational metrics. The API's own request log lines (14 days) are rolled up every 5 minutes
 * into hourly counts per method and route template (`api_metrics_hourly`, 90 days), so the numbers
 * outlive the raw logs. Rolling up recomputes whole hours, so running it on several instances is harmless.
 */
@Injectable()
export class MetricsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private lastRollup = 0;
  private rolling: Promise<void> | null = null;

  constructor(private readonly db: Database) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.rollup().catch(() => undefined), ROLLUP_EVERY_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.rolling?.catch(() => undefined);
  }

  /**
   * Recomputes the current and the two previous hours from the raw log lines (after a start, the last 13 days,
   * which fills gaps while the API was down and stays clear of the hour the 14-day log pruning is cutting), and
   * drops rows past retention.
   */
  rollup(): Promise<void> {
    this.rolling ??= this.doRollup().finally(() => (this.rolling = null));
    return this.rolling;
  }

  private async doRollup(): Promise<void> {
    const slot = (i: number) =>
      i === 0
        ? `count(*) FILTER (WHERE duration_ms <= ${LATENCY_BOUNDS_MS[0]})`
        : i < LATENCY_BOUNDS_MS.length
          ? `count(*) FILTER (WHERE duration_ms > ${LATENCY_BOUNDS_MS[i - 1]} AND duration_ms <= ${LATENCY_BOUNDS_MS[i]})`
          : `count(*) FILTER (WHERE duration_ms > ${LATENCY_BOUNDS_MS[i - 1]})`;
    await this.db.query(
      `INSERT INTO api_metrics_hourly (hour, method, route, requests, server_errors, client_errors, latency_buckets)
       SELECT date_trunc('hour', logged_at), method, route, count(*),
              count(*) FILTER (WHERE status >= 500), count(*) FILTER (WHERE status BETWEEN 400 AND 499),
              ARRAY[${Array.from({ length: 8 }, (_, i) => slot(i)).join(', ')}]::int[]
         FROM operational_logs
        WHERE event_code = 'HTTP_REQUEST' AND method IS NOT NULL AND route IS NOT NULL
          AND logged_at >= date_trunc('hour', now()) - make_interval(hours => $1)
        GROUP BY 1, 2, 3
       ON CONFLICT (hour, method, route) DO UPDATE
         SET requests = EXCLUDED.requests, server_errors = EXCLUDED.server_errors,
             client_errors = EXCLUDED.client_errors, latency_buckets = EXCLUDED.latency_buckets`,
      [this.lastRollup === 0 ? 13 * 24 : 2],
    );
    await this.db.query(`DELETE FROM api_metrics_hourly WHERE hour < now() - make_interval(days => $1)`, [METRICS_RETENTION_DAYS]);
    this.lastRollup = Date.now();
  }

  async load(q: MetricsQuery): Promise<Metrics> {
    if (Date.now() - this.lastRollup > FRESH_MS) await this.rollup();
    // Whole buckets that overlap the range; daily buckets are UTC days.
    const unit = q.bucket === '1h' ? 'hour' : 'day';
    const where = [`hour >= date_trunc('${unit}', $1::timestamptz)`, 'hour < $2'];
    const params: unknown[] = [q.from.toISOString(), q.to.toISOString()];
    if (q.method) where.push(`method = $${params.push(q.method)}`);
    if (q.route) where.push(`route = $${params.push(q.route)}`);
    const filter = where.join(' AND ');
    const sums = `SUM(requests) AS requests, SUM(server_errors) AS server_errors, SUM(client_errors) AS client_errors, ${SUM_LATENCY} AS latency`;
    const [totals, series, routes] = await Promise.all([
      this.db.query<Parameters<typeof counts>[0]>(`SELECT ${sums} FROM api_metrics_hourly WHERE ${filter}`, params),
      this.db.query<Parameters<typeof counts>[0] & { at: Date }>(
        `SELECT date_trunc('${unit}', hour) AS at, ${sums} FROM api_metrics_hourly WHERE ${filter} GROUP BY 1 ORDER BY 1`,
        params,
      ),
      this.db.query<Parameters<typeof counts>[0] & { method: string; route: string }>(
        `SELECT method, route, ${sums} FROM api_metrics_hourly WHERE ${filter} GROUP BY 1, 2 ORDER BY SUM(requests) DESC, 1, 2 LIMIT ${TOP_ROUTES}`,
        params,
      ),
    ]);
    return {
      from: q.from.toISOString(),
      to: q.to.toISOString(),
      bucket: q.bucket,
      latencyBoundsMs: LATENCY_BOUNDS_MS,
      totals: counts(totals[0]),
      series: series.map((r) => ({ at: r.at.toISOString(), ...counts(r) })),
      routes: routes.map((r) => ({ method: r.method, route: r.route, ...counts(r) })),
      retentionDays: METRICS_RETENTION_DAYS,
    };
  }
}

@Controller('v1/admin/metrics')
@UseGuards(AuthGuard, StaffGuard)
@RequireRoles('operator', 'admin')
export class AdminMetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async get(@Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response): Promise<Metrics> {
    res.setHeader('Cache-Control', 'no-store');
    return this.metrics.load(parseMetricsQuery(q));
  }
}
