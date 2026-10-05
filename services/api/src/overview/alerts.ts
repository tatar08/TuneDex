import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { StructuredLogger } from '../common/logger';
import { APP_CONFIG, AppConfig } from '../config';
import { Database, PG_POOL } from '../db/database';
import { JobKind, jobsCte } from '../jobs/queues';

/** Tests only: stands in for the network when posting to the alert webhook. */
export const ALERT_FETCH = Symbol('ALERT_FETCH');
export type AlertFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number }>;

export type AlertCode =
  | 'api_error_rate'
  | 'api_latency'
  | 'account_deletion_failed'
  | 'account_deletion_stuck'
  | 'account_deletion_late'
  | 'account_export_stuck'
  | 'idp_session_end_stuck'
  | 'job_dead_letter'
  | 'station_checker_stale'
  | 'station_rights_expiring'
  | 'backup_stale';
type Severity = 'critical' | 'warning';

export interface Reading {
  code: AlertCode;
  severity: Severity;
  /** unknown: not enough data to say either way (Doc 17: missing samples are not a pass). */
  state: 'firing' | 'ok' | 'unknown';
  value: number | null;
  sample: number | null;
}

export interface OpenAlert {
  code: AlertCode;
  severity: Severity;
  firedAt: string;
  value: number | null;
  sample: number | null;
}

/** Doc 17 thresholds. */
export const RULES = {
  errorRate: { windowMs: 5 * 60_000, minRequests: 100, threshold: 0.02 },
  latency: { windowMs: 10 * 60_000, minRequests: 20, p95Ms: 1000 },
  /**
   * Doc 17 "queue oldest > 5 min", per queue: a job normally runs seconds after it is due (requested, or its
   * backoff ended); one still waiting after this means that queue's worker is stuck.
   */
  queueStuckMs: 5 * 60_000,
  deletionLateDays: 25,
  /** Doc 14 rights expiry: a visible station whose rights end this soon needs a renewed record or it leaves the catalog. */
  rightsExpiringDays: 14,
  /** Doc 17 "no successful backup for 24 hours", with two hours' slack for a daily job that runs a little late. */
  backupStaleHours: 26,
} as const;
const EVERY_MS = 60_000;
const LOCK_KEY = 7_421_031;

const DESCRIBE: Record<AlertCode, (v: number | null, n: number | null) => string> = {
  api_error_rate: (v, n) => `API ตอบ 5xx ${((v ?? 0) * 100).toFixed(1)}% ใน 5 นาที (${n} คำขอ)`,
  api_latency: (v, n) => `API ช้า: p95 ${v} ms ใน 10 นาที (${n} คำขอ)`,
  account_deletion_failed: (v) => `ลบบัญชีไม่สำเร็จ ${v} คำขอ`,
  account_deletion_stuck: (v) => `คำขอลบบัญชีค้างเกิน 5 นาที ${v} คำขอ`,
  account_export_stuck: (v) => `คำขอส่งออกข้อมูลค้างเกิน 5 นาที ${v} คำขอ`,
  idp_session_end_stuck: (v) => `การปิดเซสชัน Keycloak ค้างเกิน 5 นาที ${v} รายการ`,
  job_dead_letter: (v) => `งานเบื้องหลังลองครบ 5 ครั้งแล้วไม่สำเร็จ ${v} งาน รอทีมงานสั่งลองใหม่`,
  account_deletion_late: (v) => `คำขอลบบัญชีค้างเกิน 25 วัน ${v} คำขอ (กำหนด 30 วัน)`,
  station_checker_stale: () => 'ตัวตรวจสตรีมไม่ได้รันเกิน 2.5 รอบ',
  backup_stale: (v) => `ไม่มี backup ที่สำเร็จมา ${v} ชั่วโมง (infra/backup/backup.sh)`,
  station_rights_expiring: (v) => `สิทธิ์เผยแพร่ของ ${v} สถานีจะหมดใน 14 วัน ต่ออายุหลักฐานก่อน ไม่อย่างนั้นสถานีจะหายจากแอป`,
};

/**
 * Evaluates the Doc 17 alert rules the API can see, once a minute on one instance (advisory lock). A rule that
 * starts firing opens an alert, logs ALERT_FIRING and posts to ALERT_WEBHOOK_URL when set; reading healthy
 * again closes it with ALERT_RESOLVED. Notifications that fail are retried on the next run. Messages carry
 * aggregates only: no user, device, request or station ids. DB pool, disk and backup alerts belong to the
 * hosting platform's monitoring (infra/README.md).
 */
@Injectable()
export class AlertService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Database,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly logger: StructuredLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ALERT_FETCH) private readonly http: AlertFetch,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.alerts.enabled) return;
    this.timer = setInterval(() => void this.run().catch(() => this.logger.log('ERROR', { eventCode: 'ALERT_EVALUATION_FAILED' })), EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One evaluation; returns false when another instance holds the lock. */
  async run(now = new Date()): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const [{ locked }] = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY])).rows;
      if (!locked) return false;
      try {
        await this.apply(await this.evaluate(now), now);
        await this.notifyPending();
        return true;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }

  async evaluate(now: Date): Promise<Reading[]> {
    const at = now.toISOString();
    const req = `FROM operational_logs WHERE event_code = 'HTTP_REQUEST' AND logged_at >= $1 AND logged_at < $2`;
    const since = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const [[errors], [latency], [deletions], queues, [lastCheck], [live], [expiring], [backup]] = await Promise.all([
      this.db.query<{ n: string; s5: string }>(`SELECT count(*) AS n, count(*) FILTER (WHERE status >= 500) AS s5 ${req}`, [since(RULES.errorRate.windowMs), at]),
      this.db.query<{ n: string; p95: number | null }>(`SELECT count(*) AS n, percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95 ${req}`, [
        since(RULES.latency.windowMs),
        at,
      ]),
      // Failed covers retrying and dead-lettered requests: both still have to finish within 30 days.
      this.db.query<{ failed: string; late: string }>(
        `SELECT count(*) FILTER (WHERE status IN ('failed', 'dead_letter')) AS failed, count(*) FILTER (WHERE requested_at < $1) AS late
           FROM account_deletions WHERE status <> 'completed'`,
        [since(RULES.deletionLateDays * 86_400_000)],
      ),
      this.db.query<{ kind: JobKind; dead: string; stuck: string }>(
        `${jobsCte(this.config.idpAdmin !== null)}
         SELECT kind, count(*) FILTER (WHERE state = 'dead_letter') AS dead, count(*) FILTER (WHERE due < $1) AS stuck FROM jobs GROUP BY kind`,
        [since(RULES.queueStuckMs)],
      ),
      this.db.query<{ at: Date | null }>(`SELECT max(checked_at) AS at FROM station_health WHERE target = 'published'`),
      this.db.query<{ n: string }>(`SELECT count(*) AS n FROM radio_stations WHERE published IS NOT NULL AND disabled_at IS NULL`),
      this.db.query<{ n: string }>(
        `SELECT count(*) AS n FROM radio_stations
          WHERE published IS NOT NULL AND disabled_at IS NULL AND rights_expires_at > $1 AND rights_expires_at <= $1::timestamptz + make_interval(days => $2)`,
        [at, RULES.rightsExpiringDays],
      ),
      this.db.query<{ at: Date | null }>(`SELECT max(finished_at) AS at FROM backup_runs`),
    ]);

    const n = Number(errors.n);
    const s5 = Number(errors.s5);
    const ln = Number(latency.n);
    const count = (code: AlertCode, severity: Severity, v: number): Reading => ({ code, severity, state: v > 0 ? 'firing' : 'ok', value: v, sample: null });
    const stuck = (kind: JobKind) => Number(queues.find((q) => q.kind === kind)?.stuck ?? 0);
    const readings: Reading[] = [
      {
        code: 'api_error_rate',
        severity: 'critical',
        state: n < RULES.errorRate.minRequests ? 'unknown' : s5 / n > RULES.errorRate.threshold ? 'firing' : 'ok',
        value: n > 0 ? s5 / n : null,
        sample: n,
      },
      {
        code: 'api_latency',
        severity: 'warning',
        state: ln < RULES.latency.minRequests || latency.p95 === null ? 'unknown' : latency.p95 > RULES.latency.p95Ms ? 'firing' : 'ok',
        value: latency.p95,
        sample: ln,
      },
      count('account_deletion_failed', 'critical', Number(deletions.failed)),
      count('account_deletion_stuck', 'warning', stuck('account_deletion')),
      count('account_deletion_late', 'critical', Number(deletions.late)),
      count('account_export_stuck', 'warning', stuck('account_export')),
      count('job_dead_letter', 'critical', queues.reduce((n, q) => n + Number(q.dead), 0)),
      count('station_rights_expiring', 'warning', Number(expiring.n)),
    ];
    // Without a Keycloak admin client no session end is ever attempted, so that queue has nothing to say.
    if (this.config.idpAdmin) readings.push(count('idp_session_end_stuck', 'warning', stuck('idp_session_end')));
    if (this.config.stationCheck.enabled && Number(live.n) > 0) {
      const late = !lastCheck.at || now.getTime() - lastCheck.at.getTime() > 2.5 * this.config.stationCheck.intervalMinutes * 60_000;
      readings.push({ code: 'station_checker_stale', severity: 'warning', state: late ? 'firing' : 'ok', value: null, sample: null });
    }
    // Only once backup.sh has recorded a run: a deployment that relies on the provider's backups alone has none.
    if (backup.at) {
      const hours = Math.floor((now.getTime() - backup.at.getTime()) / 3_600_000);
      readings.push({ code: 'backup_stale', severity: 'critical', state: hours >= RULES.backupStaleHours ? 'firing' : 'ok', value: hours, sample: null });
    }
    return readings;
  }

  /** Alerts open right now, for the overview. */
  async open(): Promise<OpenAlert[]> {
    const rows = await this.db.query<{ code: AlertCode; severity: Severity; fired_at: Date; value: number | null; sample: number | null }>(
      'SELECT code, severity, fired_at, value, sample FROM alerts WHERE resolved_at IS NULL ORDER BY fired_at',
    );
    return rows.map((r) => ({ code: r.code, severity: r.severity, firedAt: r.fired_at.toISOString(), value: r.value, sample: r.sample }));
  }

  private async apply(readings: Reading[], now: Date): Promise<void> {
    const open = new Map((await this.db.query<{ id: string; code: string }>('SELECT id, code FROM alerts WHERE resolved_at IS NULL')).map((r) => [r.code, r.id]));
    for (const r of readings) {
      const id = open.get(r.code);
      if (r.state === 'firing' && !id) {
        await this.db.query('INSERT INTO alerts (code, severity, fired_at, last_seen_at, value, sample) VALUES ($1, $2, $3, $3, $4, $5) ON CONFLICT DO NOTHING', [
          r.code,
          r.severity,
          now,
          r.value,
          r.sample,
        ]);
        this.logger.log(r.severity === 'critical' ? 'ERROR' : 'WARN', { eventCode: 'ALERT_FIRING', errorCode: r.code });
      } else if (r.state === 'firing' && id) {
        await this.db.query('UPDATE alerts SET last_seen_at = $2, value = $3, sample = $4 WHERE id = $1', [id, now, r.value, r.sample]);
      } else if (r.state === 'ok' && id) {
        await this.db.query('UPDATE alerts SET resolved_at = $2 WHERE id = $1', [id, now]);
        this.logger.log('INFO', { eventCode: 'ALERT_RESOLVED', errorCode: r.code });
      }
    }
  }

  /** Posts every transition not yet delivered. Without ALERT_WEBHOOK_URL the logs are the only channel. */
  private async notifyPending(): Promise<void> {
    const url = this.config.alerts.webhookUrl;
    if (!url) return;
    const pending = await this.db.query<{ id: string; code: AlertCode; severity: Severity; value: number | null; sample: number | null; resolved: boolean }>(
      `SELECT id, code, severity, value, sample, resolved_at IS NOT NULL AS resolved FROM alerts
        WHERE (fire_notified_at IS NULL OR (resolved_at IS NOT NULL AND resolve_notified_at IS NULL)) AND fired_at > now() - interval '1 day'
        ORDER BY id`,
    );
    for (const a of pending) {
      const head = a.resolved ? '✅ กลับมาปกติ' : a.severity === 'critical' ? '🔴 วิกฤต' : '🟠 เตือน';
      const text = `${head} · TuneDeck ${this.config.env} · ${DESCRIBE[a.code](a.value, a.sample)} [${a.code}]`;
      try {
        const res = await this.http(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, content: text }),
          signal: AbortSignal.timeout(5_000),
        });
        if (res.status < 200 || res.status >= 300) throw Object.assign(new Error('webhook'), { status: res.status });
        await this.db.query(a.resolved ? 'UPDATE alerts SET fire_notified_at = coalesce(fire_notified_at, now()), resolve_notified_at = now() WHERE id = $1' : 'UPDATE alerts SET fire_notified_at = now() WHERE id = $1', [a.id]);
      } catch (err) {
        this.logger.log('WARN', { eventCode: 'ALERT_NOTIFY_FAILED', errorCode: a.code, ...(typeof (err as { status?: number }).status === 'number' ? { status: (err as { status: number }).status } : {}) });
        return;
      }
    }
  }
}
