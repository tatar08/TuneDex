import request from 'supertest';
import { AlertService } from '../src/overview/alerts';
import { Database } from '../src/db/database';
import { runStaffCli } from '../src/staff/staff-cli';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

describe('Doc 17 alerts', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const posts: { url: string; text: string }[] = [];
  let webhookStatus = 200;
  const minutes = (n: number, from = Date.now()) => new Date(from + n * 60_000);

  /** Seeds request log rows `agoSec` before `at`, as the log sink would have written them. */
  async function requests(at: Date, rows: { status: number; durationMs: number; count: number }[]) {
    for (const r of rows) {
      await t.pool.query(
        `INSERT INTO operational_logs (logged_at, severity, service, environment, build, event_code, method, route, status, duration_ms)
         SELECT $1::timestamptz - (g * interval '1 second'), 'INFO', 'api', 'dev', 'test', 'HTTP_REQUEST', 'GET', '/v1/me/settings', $2, $3 FROM generate_series(1, $4) g`,
        [at, r.status, r.durationMs, r.count],
      );
    }
  }
  const alerts = () => t.app.get(AlertService);
  const open = async () => (await t.pool.query<{ code: string }>('SELECT code FROM alerts WHERE resolved_at IS NULL ORDER BY code')).rows.map((r) => r.code);

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver, {
      config: { alerts: { enabled: false, webhookUrl: 'https://hooks.example.test/T000/secret' } },
      alertFetch: async (url, init) => {
        posts.push({ url, text: JSON.parse(init.body).text });
        return { status: webhookStatus };
      },
    });
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('says nothing without enough traffic, fires on 5xx over 2% of 100+ requests, notifies once, then resolves', async () => {
    const t0 = new Date();
    await requests(t0, [{ status: 200, durationMs: 40, count: 30 }]);
    expect(await alerts().run(t0)).toBe(true);
    expect(await open()).toEqual([]);

    await requests(t0, [
      { status: 200, durationMs: 40, count: 100 },
      { status: 503, durationMs: 40, count: 5 },
    ]);
    t.logs.mark();
    await alerts().run(t0);
    expect(await open()).toEqual(['api_error_rate']);
    expect(t.logs.lines()).toContainEqual(expect.objectContaining({ eventCode: 'ALERT_FIRING', errorCode: 'api_error_rate', severity: 'ERROR' }));
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain('🔴');
    expect(posts[0].text).toContain('5xx 3.7%');
    expect(posts[0].text).not.toMatch(/req_|user|[0-9a-f]{8}-[0-9a-f]{4}/);
    // The webhook URL is a secret and never reaches the logs.
    expect(t.logs.raw()).not.toContain('hooks.example.test');

    // Still firing: no second message.
    await alerts().run(t0);
    expect(posts).toHaveLength(1);

    // Six minutes later the window holds only healthy traffic.
    const t1 = minutes(6, t0.getTime());
    await requests(t1, [{ status: 200, durationMs: 40, count: 120 }]);
    await alerts().run(t1);
    expect(await open()).toEqual([]);
    expect(posts.at(-1)!.text).toContain('✅');
  });

  it('a quiet window keeps an open alert open (missing data is not a pass)', async () => {
    const t0 = minutes(30);
    await requests(t0, [{ status: 500, durationMs: 40, count: 110 }]);
    await alerts().run(t0);
    expect(await open()).toEqual(['api_error_rate']);
    await alerts().run(minutes(45));
    expect(await open()).toEqual(['api_error_rate']);
    await requests(minutes(60), [{ status: 200, durationMs: 40, count: 110 }]);
    await alerts().run(minutes(60));
    expect(await open()).toEqual([]);
  });

  it('retries a notification the webhook refused', async () => {
    const before = posts.length;
    webhookStatus = 500;
    const t0 = minutes(120);
    await requests(t0, [{ status: 200, durationMs: 1500, count: 25 }]);
    t.logs.mark();
    await alerts().run(t0);
    expect(await open()).toEqual(['api_latency']);
    expect(t.logs.lines()).toContainEqual(expect.objectContaining({ eventCode: 'ALERT_NOTIFY_FAILED', errorCode: 'api_latency', status: 500 }));
    webhookStatus = 200;
    await alerts().run(t0);
    expect(posts.slice(before).filter((p) => p.text.includes('p95 1500 ms'))).toHaveLength(2);
  });

  it('flags a deletion queue that is stuck, and shows open alerts on the overview with when they started', async () => {
    const [{ id: userId }] = (await t.pool.query(`INSERT INTO users (oidc_subject, status) VALUES ('alert-stuck', 'deleting') RETURNING id`)).rows;
    await t.pool.query(`INSERT INTO account_deletions (ticket_hash, user_id, subject_hash, requested_at) VALUES ('h-alert', $1, 's', now() - interval '10 minutes')`, [userId]);
    await alerts().run(new Date());
    expect(await open()).toContain('account_deletion_stuck');

    await request(t.app.getHttpServer()).get('/v1/me/settings').set('Authorization', `Bearer ${await id.token('alert-ops')}`).expect(200);
    expect(await runStaffCli(['grant', 'alert-ops', 'operator', '--by', 'tar', '--reason', 'alerts'], new Database(t.pool), () => undefined)).toBe(0);
    const res = await request(t.app.getHttpServer()).get('/v1/admin/overview?window=1h').set('Authorization', `Bearer ${await id.token('alert-ops')}`).expect(200);
    const stuck = res.body.incidents.find((i: { code: string }) => i.code === 'account_deletion_stuck');
    expect(stuck).toMatchObject({ severity: 'warning', count: 1 });
    expect(typeof stuck.since).toBe('string');
  });
});
