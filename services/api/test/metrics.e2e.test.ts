import request from 'supertest';
import { Database } from '../src/db/database';
import { MetricsService, parseMetricsQuery, percentileUpTo } from '../src/overview/metrics';
import { runStaffCli } from '../src/staff/staff-cli';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

describe('/v1/admin/metrics (Doc 17)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());
  const bearer = async (sub: string) => ({ Authorization: `Bearer ${await id.token(sub)}` });

  async function seed(rows: { minsAgo: number; status: number; ms: number; route?: string; method?: string; n?: number }[]) {
    for (const r of rows) {
      await t.pool.query(
        `INSERT INTO operational_logs (logged_at, severity, service, environment, build, event_code, method, route, status, duration_ms)
         SELECT now() - make_interval(mins => $1), 'INFO', 'api', 'test', 'test', 'HTTP_REQUEST', $6, $2, $3, $4 FROM generate_series(1, $5)`,
        [r.minsAgo, r.route ?? '/v1/me/settings', r.status, r.ms, r.n ?? 1, r.method ?? 'GET'],
      );
    }
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
    const staff = (...args: string[]) => runStaffCli(args, new Database(t.pool), () => undefined);
    await http().get('/v1/me/settings').set(await bearer('m-ops')).expect(200);
    await http().get('/v1/me/settings').set(await bearer('m-editor')).expect(200);
    expect(await staff('grant', 'm-ops', 'operator', '--by', 'tar', '--reason', 'ops')).toBe(0);
    expect(await staff('grant', 'm-editor', 'catalog_editor', '--by', 'tar', '--reason', 'catalog')).toBe(0);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('is for operators and admins, with bounded filters', async () => {
    expect((await http().get('/v1/admin/metrics')).status).toBe(401);
    expect((await http().get('/v1/admin/metrics').set(await bearer('m-editor'))).status).toBe(403);
    const ops = await bearer('m-ops');
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    // Hourly points over at most 14 days, daily over at most 90.
    expect((await http().get('/v1/admin/metrics').query({ from: iso(15 * 86_400_000), bucket: '1h' }).set(ops)).status).toBe(400);
    expect((await http().get('/v1/admin/metrics').query({ from: iso(30 * 86_400_000), bucket: '1d' }).set(ops)).status).toBe(200);
    expect((await http().get('/v1/admin/metrics').query({ from: iso(95 * 86_400_000), bucket: '1d' }).set(ops)).status).toBe(400);
    expect((await http().get('/v1/admin/metrics').query({ bucket: '5m' }).set(ops)).status).toBe(400);
    expect((await http().get('/v1/admin/metrics').query({ route: 'v1/no-leading-slash' }).set(ops)).status).toBe(400);
    expect(() => parseMetricsQuery({ from: iso(0), to: iso(60_000) })).toThrow();
  });

  it('counts requests per hour and per route, and outlives the raw log lines', async () => {
    await t.pool.query('DELETE FROM operational_logs');
    await t.pool.query('DELETE FROM api_metrics_hourly');
    await seed([
      { minsAgo: 1, status: 200, ms: 40, n: 90 },
      { minsAgo: 1, status: 404, ms: 80, n: 5 },
      { minsAgo: 1, status: 503, ms: 3000, n: 5, route: '/v1/catalog/radio' },
      { minsAgo: 1, status: 201, ms: 300, n: 10, method: 'POST', route: '/v1/sync/push' },
    ]);
    const service = t.app.get(MetricsService);
    await service.rollup();
    // The raw lines go (14-day log retention); the hourly counts stay.
    await t.pool.query('DELETE FROM operational_logs');
    const m = await service.load(parseMetricsQuery({}));

    expect(m.totals).toMatchObject({ requests: 110, serverErrors: 5, clientErrors: 5, p50UpToMs: 50, p95UpToMs: 500 });
    expect(m.totals.errorRate).toBeCloseTo(5 / 110);
    expect(m.series.at(-1)).toMatchObject({ requests: 110 });
    expect(m.routes[0]).toMatchObject({ method: 'GET', route: '/v1/me/settings', requests: 95, serverErrors: 0, p95UpToMs: 100 });
    expect(m.routes.find((r) => r.route === '/v1/catalog/radio')).toMatchObject({ requests: 5, errorRate: 1, p95UpToMs: 5000 });

    const filtered = await http().get('/v1/admin/metrics').query({ method: 'POST', route: '/v1/sync/push' }).set(await bearer('m-ops')).expect(200);
    expect(filtered.headers['cache-control']).toBe('no-store');
    expect(filtered.body.totals).toMatchObject({ requests: 10, p95UpToMs: 500 });
    expect(filtered.body.routes).toEqual([expect.objectContaining({ method: 'POST', route: '/v1/sync/push' })]);
    // No user, station or request ids in any label.
    expect(JSON.stringify(filtered.body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('reports nothing as nothing, and drops rows past 90 days', async () => {
    await t.pool.query('DELETE FROM api_metrics_hourly');
    await t.pool.query(
      `INSERT INTO api_metrics_hourly (hour, method, route, requests, server_errors, client_errors, latency_buckets)
       VALUES (date_trunc('hour', now()) - interval '91 days', 'GET', '/v1/me', 1, 0, 0, '{1,0,0,0,0,0,0,0}')`,
    );
    const service = t.app.get(MetricsService);
    await service.rollup();
    expect((await t.pool.query('SELECT 1 FROM api_metrics_hourly')).rows).toHaveLength(0);
    const m = await service.load(parseMetricsQuery({}));
    expect(m.totals).toMatchObject({ requests: 0, errorRate: null, p50UpToMs: null, p95UpToMs: null });
    expect(m.series).toEqual([]);
    expect(percentileUpTo([0, 0, 0, 0, 0, 0, 0, 3], 0.95)).toBeNull();
  });
});
