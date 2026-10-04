import request from 'supertest';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

describe('rate limits', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver, {
      config: { rateLimit: { enabled: true, readsPerMinute: 5, writesPerMinute: 2, catalogPerMinutePerIp: 3, trustProxyHops: 1 } },
    });
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });
  /** Each test starts with empty counters, and not in the last seconds of a minute (a new window would reset them mid-test). */
  beforeEach(async () => {
    const s = new Date().getSeconds();
    if (s >= 55) await new Promise((r) => setTimeout(r, (61 - s) * 1000));
    await t.pool.query('TRUNCATE rate_limit_counters');
  }, 10_000);

  it('limits reads per user and says when to come back', async () => {
    const alice = { Authorization: `Bearer ${await id.token('rl-alice')}` };
    for (let i = 0; i < 5; i++) await http().get('/v1/me/settings').set(alice).expect(200);
    const over = await http().get('/v1/me/settings').set(alice);
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ code: 'API_RATE_LIMITED', messageKey: 'errors.request.rateLimited' });
    const retry = Number(over.headers['retry-after']);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    expect(over.body.details.retryAfterSeconds).toBe(retry);

    // Another user has their own allowance.
    await http().get('/v1/me/settings').set({ Authorization: `Bearer ${await id.token('rl-bob')}` }).expect(200);
  });

  it('counts writes separately from reads', async () => {
    const carol = { Authorization: `Bearer ${await id.token('rl-carol')}` };
    const settings = await http().get('/v1/me/settings').set(carol).expect(200);
    let rev = settings.body.revision;
    for (let i = 0; i < 2; i++) {
      const res = await http().patch('/v1/me/settings').set(carol).set('If-Match', `"${rev}"`).send({ theme: i % 2 ? 'dark' : 'light' });
      expect(res.status).toBe(200);
      rev = res.body.revision;
    }
    expect((await http().patch('/v1/me/settings').set(carol).set('If-Match', `"${rev}"`).send({ theme: 'system' })).status).toBe(429);
    await http().get('/v1/me/settings').set(carol).expect(200);
  });

  it('limits the public catalog per client address, behind our proxy', async () => {
    for (let i = 0; i < 3; i++) await http().get('/v1/catalog/radio').set('X-Forwarded-For', '203.0.113.7').expect(200);
    expect((await http().get('/v1/catalog/radio').set('X-Forwarded-For', '203.0.113.7')).status).toBe(429);
    await http().get('/v1/catalog/radio').set('X-Forwarded-For', '203.0.113.8').expect(200);
    const rows = await t.pool.query('SELECT bucket FROM rate_limit_counters');
    expect(JSON.stringify(rows.rows)).not.toContain('203.0.113');
  });

  it('never limits health probes or rejected sign-ins', async () => {
    for (let i = 0; i < 10; i++) await http().get('/health/live').expect(200);
    for (let i = 0; i < 10; i++) await http().get('/v1/me/settings').expect(401);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM rate_limit_counters')).rows[0].n).toBe(0);
  });

  it('lets requests through if the counters cannot be written', async () => {
    await t.pool.query('ALTER TABLE rate_limit_counters RENAME TO rate_limit_counters_off');
    try {
      const dave = { Authorization: `Bearer ${await id.token('rl-dave')}` };
      for (let i = 0; i < 8; i++) await http().get('/v1/me/settings').set(dave).expect(200);
      expect(t.logs.raw()).toContain('RATE_LIMIT_UNAVAILABLE');
    } finally {
      await t.pool.query('ALTER TABLE rate_limit_counters_off RENAME TO rate_limit_counters');
    }
  });
});
