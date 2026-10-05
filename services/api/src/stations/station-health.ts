import { HttpStatus, Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown, Optional } from '@nestjs/common';
import type { Pool } from 'pg';
import { writeAudit } from '../audit/audit';
import { ApiError } from '../common/api-error';
import { StructuredLogger } from '../common/logger';
import { APP_CONFIG, AppConfig } from '../config';
import { Database, PG_POOL } from '../db/database';
import { httpsFetchFrom, probeStream, ProbeDeps, ProbeResult, systemResolve } from './stream-probe';
import type { StationActor } from './stations.service';

/** Lets tests swap DNS and HTTPS for fakes. The address policy in probeStream still applies. */
export const PROBE_DEPS = Symbol('PROBE_DEPS');

export const SUSPECT_AFTER = 3;
export const HEALTH_RETENTION_DAYS = 30;
const CONCURRENCY = 4;
const MANUAL_COOLDOWN_SECONDS = 60;
const HISTORY = 20;
/** Fixed key so only one API instance runs the scheduled check at a time. */
const LOCK_KEY = 7_421_017;
/** Worker mode: how long the API waits for the checker to answer a "check now", and how old a request it still takes. */
const WORKER_WAIT_MS = 15_000;
const REQUEST_MAX_AGE_SECONDS = 20;
const REQUEST_POLL_MS = 1_000;

export type HealthState = 'unknown' | 'ok' | 'failing' | 'suspect';

export interface RegionHealth {
  region: string;
  state: Exclude<HealthState, 'unknown'>;
  checkedAt: string;
  reason: string;
  httpStatus: number | null;
  latencyMs: number | null;
  /** Failures in a row, counted up to SUSPECT_AFTER. */
  consecutiveFailures: number;
}

/** Health of the published stream. Draft checks show in history but never change this. */
export interface StationHealth {
  state: HealthState;
  regions: RegionHealth[];
}

export interface HealthCheck {
  region: string;
  checkedAt: string;
  target: 'published' | 'draft';
  ok: boolean;
  reason: string;
  httpStatus: number | null;
  latencyMs: number | null;
}

const UNKNOWN: StationHealth = { state: 'unknown', regions: [] };
const RANK: Record<HealthState, number> = { unknown: 0, ok: 1, failing: 2, suspect: 3 };

interface RecentRow {
  station_id: string;
  check_region: string;
  checked_at: Date;
  status: 'ok' | 'fail';
  reason: string;
  http_status: number | null;
  latency_ms: number | null;
}

/**
 * Doc 17 catalog checker: probes each published, enabled station on a schedule and records
 * result codes (never URLs). Three failures in a row mark a station "suspect" for an admin
 * to review; nothing is disabled automatically (Doc 18).
 */
@Injectable()
export class StationHealthService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private requestTimer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;
  private stopped = false;
  private readonly probe: ProbeDeps;

  constructor(
    private readonly db: Database,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: StructuredLogger,
    @Optional() @Inject(PROBE_DEPS) probe?: ProbeDeps,
  ) {
    this.probe = probe ?? { resolve: systemResolve, fetchFrom: httpsFetchFrom };
  }

  onApplicationBootstrap(): void {
    if (this.config.stationCheck.enabled && this.config.stationCheck.runner === 'api') this.schedule();
  }

  /** The `npm run checker` process: scheduled passes (when enabled) and staff "check now" requests. */
  startWorker(): void {
    if (this.config.stationCheck.enabled) this.schedule();
    const loop = () => {
      if (this.stopped) return;
      this.requestTimer = setTimeout(() => {
        void this.serveRequests()
          .catch(() => undefined)
          .finally(loop);
      }, REQUEST_POLL_MS);
    };
    loop();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.requestTimer) clearTimeout(this.requestTimer);
    await this.running?.catch(() => undefined);
  }

  /** Next run after the interval plus up to 10% jitter, so instances and stations do not line up. */
  private schedule(): void {
    if (this.stopped) return;
    const base = this.config.stationCheck.intervalMinutes * 60_000;
    this.timer = setTimeout(() => {
      void this.runOnce()
        .catch(() => undefined)
        .finally(() => this.schedule());
    }, base + Math.floor(Math.random() * base * 0.1));
    this.timer.unref();
  }

  /** One pass over the live catalog. Returns how many stations were checked (0 if another instance holds the lock). */
  runOnce(): Promise<number> {
    if (!this.running) this.running = this.pass().finally(() => (this.running = null));
    return this.running;
  }

  private async pass(): Promise<number> {
    const started = Date.now();
    const client = await this.pool.connect();
    try {
      const [{ locked }] = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY])).rows;
      if (!locked) return 0;
      try {
        const stations = await this.db.query<{ id: string; url: string }>(
          `SELECT id, published->>'streamUrl' AS url FROM radio_stations
            WHERE published IS NOT NULL AND disabled_at IS NULL
              AND (rights_expires_at IS NULL OR rights_expires_at > now())
            ORDER BY id`,
        );
        let next = 0;
        const worker = async () => {
          while (!this.stopped && next < stations.length) {
            const s = stations[next++];
            await this.record(s.id, 'published', await probeStream(s.url, this.probe));
          }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
        await this.prune();
        this.logger.log('INFO', { eventCode: 'STATION_CHECK_RUN', durationMs: Date.now() - started });
        return stations.length;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
      }
    } catch (err) {
      this.logger.log('ERROR', { eventCode: 'STATION_CHECK_FAILED', errorName: (err as Error)?.name ?? 'Error' });
      throw err;
    } finally {
      client.release();
    }
  }

  private async record(stationId: string, target: 'published' | 'draft', r: ProbeResult, query: Database['query'] = this.db.query.bind(this.db)) {
    await query(
      `INSERT INTO station_health (station_id, check_region, status, reason, http_status, latency_ms, content_type, target)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [stationId, this.config.stationCheck.region, r.ok ? 'ok' : 'fail', r.reason, r.httpStatus, r.latencyMs, r.contentType, target],
    );
  }

  private async prune(): Promise<void> {
    await this.db.query(`DELETE FROM station_health WHERE checked_at < now() - make_interval(days => $1)`, [HEALTH_RETENTION_DAYS]);
    await this.db.query(`DELETE FROM station_check_requests WHERE requested_at < now() - interval '1 day'`);
  }

  /** Checker process: answers waiting "check now" requests one by one. Returns how many it answered. */
  async serveRequests(): Promise<number> {
    let served = 0;
    while (!this.stopped) {
      const [req] = await this.db.query<{ id: string; station_id: string; target: 'published' | 'draft' }>(
        `UPDATE station_check_requests SET claimed_at = now()
          WHERE id = (SELECT id FROM station_check_requests
                       WHERE claimed_at IS NULL AND requested_at > now() - make_interval(secs => $1)
                       ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1)
          RETURNING id, station_id, target`,
        [REQUEST_MAX_AGE_SECONDS],
      );
      if (!req) return served;
      const [s] = await this.db.query<{ url: string | null }>(
        `SELECT CASE WHEN $2 = 'published' THEN published->>'streamUrl' ELSE draft->>'streamUrl' END AS url FROM radio_stations WHERE id = $1`,
        [req.station_id, req.target],
      );
      const result: ProbeResult = s?.url ? await probeStream(s.url, this.probe) : { ok: false, reason: 'invalid_url', httpStatus: null, latencyMs: 0, contentType: null };
      if (s?.url) await this.record(req.station_id, req.target, result);
      await this.db.query(`UPDATE station_check_requests SET done_at = now(), result = $2 WHERE id = $1`, [req.id, JSON.stringify(result)]);
      served++;
    }
    return served;
  }

  /** API in worker mode: hands the probe to the checker process and waits for its answer. */
  private async viaWorker(stationId: string, target: 'published' | 'draft'): Promise<ProbeResult> {
    const [{ id }] = await this.db.query<{ id: string }>(
      `INSERT INTO station_check_requests (station_id, target) VALUES ($1, $2) RETURNING id`,
      [stationId, target],
    );
    const deadline = Date.now() + WORKER_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      const [row] = await this.db.query<{ result: ProbeResult | null }>(`SELECT result FROM station_check_requests WHERE id = $1 AND done_at IS NOT NULL`, [id]);
      if (row?.result) return row.result;
    }
    // Withdraw it if nobody took it, so a checker coming back later does not run a stale request.
    await this.db.query(`DELETE FROM station_check_requests WHERE id = $1 AND claimed_at IS NULL`, [id]);
    this.logger.log('WARN', { eventCode: 'STATION_CHECKER_UNAVAILABLE' });
    throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'CHECKER_UNAVAILABLE');
  }

  /**
   * Staff "check now": probes the published stream, or the draft one before the first publish
   * (staff-entered and validated like every stream URL). One manual check per station per minute,
   * counted from the audit trail so scheduled checks never block it.
   */
  async checkNow(actor: StationActor, id: string): Promise<HealthCheck> {
    const [s] = await this.db.query<{ draft_url: string; published_url: string | null; last: Date | null }>(
      `SELECT draft->>'streamUrl' AS draft_url, published->>'streamUrl' AS published_url,
              (SELECT max(occurred_at) FROM audit_events a
                WHERE a.target_type = 'station' AND a.target_id = s.id::text AND a.action = 'station.check'
                  AND a.occurred_at > now() - make_interval(secs => $2)) AS last
         FROM radio_stations s WHERE id = $1`,
      [id, MANUAL_COOLDOWN_SECONDS],
    );
    if (!s) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    if (s.last) throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'CHECK_TOO_SOON', { retryAfterSeconds: MANUAL_COOLDOWN_SECONDS });
    const target = s.published_url ? 'published' : 'draft';
    const byWorker = this.config.stationCheck.runner === 'worker';
    const result = byWorker ? await this.viaWorker(id, target) : await probeStream(s.published_url ?? s.draft_url, this.probe);
    await this.db.transaction(async (query) => {
      // The checker process records its own result.
      if (!byWorker) await this.record(id, target, result, query);
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: 'station.check',
        targetType: 'station',
        targetId: id,
        changes: { target, result: result.reason },
        requestId: actor.requestId,
      });
    });
    return {
      region: this.config.stationCheck.region,
      checkedAt: new Date().toISOString(),
      target,
      ok: result.ok,
      reason: result.reason,
      httpStatus: result.httpStatus,
      latencyMs: result.latencyMs,
    };
  }

  /** Current health per station, from checks of the live snapshot since it was last published. */
  async summaries(ids: string[]): Promise<Map<string, StationHealth>> {
    const out = new Map<string, StationHealth>();
    if (!ids.length) return out;
    const rows = await this.db.query<RecentRow>(
      `SELECT station_id, check_region, checked_at, status, reason, http_status, latency_ms FROM (
         SELECT h.*, row_number() OVER (PARTITION BY h.station_id, h.check_region ORDER BY h.checked_at DESC, h.id DESC) AS rn
           FROM station_health h JOIN radio_stations s ON s.id = h.station_id
          WHERE h.station_id = ANY($1::uuid[]) AND h.target = 'published'
            AND s.published_at IS NOT NULL AND h.checked_at >= s.published_at
       ) t WHERE rn <= $2 ORDER BY station_id, check_region, checked_at DESC, id DESC`,
      [ids, SUSPECT_AFTER],
    );
    const grouped = new Map<string, Map<string, RecentRow[]>>();
    for (const r of rows) {
      const byRegion = grouped.get(r.station_id) ?? new Map<string, RecentRow[]>();
      byRegion.set(r.check_region, [...(byRegion.get(r.check_region) ?? []), r]);
      grouped.set(r.station_id, byRegion);
    }
    for (const [stationId, byRegion] of grouped) {
      const regions = [...byRegion.entries()].map(([region, recent]): RegionHealth => {
        const failures = recent.findIndex((r) => r.status === 'ok');
        const consecutiveFailures = failures === -1 ? recent.length : failures;
        const latest = recent[0];
        return {
          region,
          state: consecutiveFailures === 0 ? 'ok' : consecutiveFailures >= SUSPECT_AFTER ? 'suspect' : 'failing',
          checkedAt: latest.checked_at.toISOString(),
          reason: latest.reason,
          httpStatus: latest.http_status,
          latencyMs: latest.latency_ms,
          consecutiveFailures,
        };
      });
      const state = regions.reduce<HealthState>((worst, r) => (RANK[r.state] > RANK[worst] ? r.state : worst), 'unknown');
      out.set(stationId, { state, regions });
    }
    return out;
  }

  async summary(id: string): Promise<StationHealth> {
    return (await this.summaries([id])).get(id) ?? UNKNOWN;
  }

  async history(id: string): Promise<HealthCheck[]> {
    const rows = await this.db.query<RecentRow & { target: 'published' | 'draft' }>(
      `SELECT check_region, checked_at, status, reason, http_status, latency_ms, target
         FROM station_health WHERE station_id = $1 ORDER BY checked_at DESC, id DESC LIMIT $2`,
      [id, HISTORY],
    );
    return rows.map((r) => ({
      region: r.check_region,
      checkedAt: r.checked_at.toISOString(),
      target: r.target,
      ok: r.status === 'ok',
      reason: r.reason,
      httpStatus: r.http_status,
      latencyMs: r.latency_ms,
    }));
  }
}

export const unknownHealth = (): StationHealth => ({ ...UNKNOWN, regions: [] });
