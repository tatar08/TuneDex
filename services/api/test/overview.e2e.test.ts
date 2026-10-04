import request from 'supertest';
import { Database } from '../src/db/database';
import { OverviewService } from '../src/overview/overview';
import { runStaffCli } from '../src/staff/staff-cli';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

describe('/v1/admin/overview', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());
  const bearer = async (sub: string) => ({ Authorization: `Bearer ${await id.token(sub)}` });

  /** Request log lines as the API's own logger would store them, `minsAgo` before now. */
  async function seedRequests(rows: { minsAgo: number; status: number; ms: number; route?: string; n?: number }[]) {
    for (const r of rows) {
      await t.pool.query(
        `INSERT INTO operational_logs (logged_at, severity, service, environment, build, event_code, method, route, status, duration_ms)
         SELECT now() - make_interval(mins => $1), 'INFO', 'api', 'test', 'test', 'HTTP_REQUEST', 'GET', $2, $3, $4 FROM generate_series(1, $5)`,
        [r.minsAgo, r.route ?? '/v1/me/settings', r.status, r.ms, r.n ?? 1],
      );
    }
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
    const staff = (...args: string[]) => runStaffCli(args, new Database(t.pool), () => undefined);
    await http().get('/v1/me/settings').set(await bearer('ov-ops')).expect(200);
    await http().get('/v1/me/settings').set(await bearer('ov-editor')).expect(200);
    expect(await staff('grant', 'ov-ops', 'operator', '--by', 'tar', '--reason', 'ops')).toBe(0);
    expect(await staff('grant', 'ov-editor', 'catalog_editor', '--by', 'tar', '--reason', 'catalog')).toBe(0);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('is for operators and admins only', async () => {
    expect((await http().get('/v1/admin/overview')).status).toBe(401);
    expect((await http().get('/v1/admin/overview').set(await bearer('ov-editor'))).status).toBe(403);
    expect((await http().get('/v1/admin/overview').query({ window: '30d' }).set(await bearer('ov-ops'))).status).toBe(400);
  });

  it('reports a quiet system as stale, not as healthy', async () => {
    await t.pool.query('DELETE FROM operational_logs');
    const o = await t.app.get(OverviewService).load('1h');
    expect(o.api).toMatchObject({ requests: 0, errorRate: null, p95Ms: null, stale: true });
    expect(o.api.buckets).toHaveLength(12);
    expect(o.incidents.map((i) => i.code)).toEqual(['no_recent_traffic']);
  });

  it('counts traffic, errors and latency, and raises an error-rate incident only with enough samples', async () => {
    await t.pool.query('DELETE FROM operational_logs');
    await seedRequests([
      { minsAgo: 2, status: 200, ms: 40, n: 90 },
      { minsAgo: 3, status: 404, ms: 10, n: 3 },
      { minsAgo: 4, status: 503, ms: 900, n: 7, route: '/v1/catalog/stations' },
      { minsAgo: 120, status: 500, ms: 50, n: 30 }, // outside the 1h window
    ]);
    const o = await t.app.get(OverviewService).load('1h');
    expect(o.api).toMatchObject({ requests: 100, serverErrors: 7, clientErrors: 3, errorRate: 0.07, p50Ms: 40, stale: false });
    expect(o.api.p95Ms).toBe(900);
    expect(o.api.topErrors).toEqual([{ route: '/v1/catalog/stations', status: 503, count: 7 }]);
    expect(o.api.buckets.reduce((a, b) => a + b.requests, 0)).toBe(100);
    expect(o.incidents).toContainEqual({ code: 'api_error_rate', severity: 'critical', count: 7 });

    await t.pool.query('DELETE FROM operational_logs');
    await seedRequests([{ minsAgo: 2, status: 200, ms: 40, n: 10 }, { minsAgo: 2, status: 500, ms: 40, n: 5 }]);
    const small = await t.app.get(OverviewService).load('1h');
    expect(small.api.errorRate).toBeCloseTo(1 / 3);
    expect(small.incidents.map((i) => i.code)).not.toContain('api_error_rate');
  });

  it('flags a failed account deletion and returns aggregates only', async () => {
    const who = await bearer('ov-leaver');
    await http().get('/v1/me/settings').set(who).expect(200);
    const { rows: [u] } = await t.pool.query(`SELECT id FROM users WHERE oidc_subject = 'ov-leaver'`);
    await t.pool.query(`INSERT INTO account_deletions (ticket_hash, user_id, subject_hash, status) VALUES ('h1', $1, 's1', 'failed')`, [u.id]);
    const res = await http().get('/v1/admin/overview').query({ window: '24h' }).set(await bearer('ov-ops')).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.queues.accountDeletions).toMatchObject({ open: 1, failed: 1, deadlineDays: 30 });
    expect(res.body.incidents).toContainEqual({ code: 'account_deletion_failed', severity: 'critical', count: 1 });
    expect(res.body.api.buckets).toHaveLength(24);
    expect(JSON.stringify(res.body)).not.toContain(u.id);
  });
});
