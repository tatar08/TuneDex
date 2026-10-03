import request from 'supertest';
import { Database } from '../src/db/database';
import { PgLogStore } from '../src/logs/log-store';
import { parseLogQuery } from '../src/logs/logs';
import { runStaffCli } from '../src/staff/staff-cli';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

describe('operational logs', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let tokens: Record<'operator' | 'admin' | 'editor' | 'user', string>;
  const http = () => request(t.app.getHttpServer());
  const as = (who: keyof typeof tokens) => ({ Authorization: `Bearer ${tokens[who]}` });
  const staff = (...args: string[]) => runStaffCli(args, new Database(t.pool), () => undefined);
  const flush = () => t.app.get(PgLogStore).flush();
  const search = (who: keyof typeof tokens, q: Record<string, string> = {}) => http().get('/v1/admin/logs').query(q).set(as(who));

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
    tokens = {
      operator: await id.token('ops-1'),
      admin: await id.token('admin-1'),
      editor: await id.token('editor-1'),
      user: await id.token('user-1'),
    };
    expect(await staff('grant', 'ops-1', 'operator', '--by', 'tar', '--reason', 'on call')).toBe(0);
    expect(await staff('grant', 'admin-1', 'admin', '--by', 'tar', '--reason', 'admin')).toBe(0);
    expect(await staff('grant', 'editor-1', 'catalog_editor', '--by', 'tar', '--reason', 'catalog')).toBe(0);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('lets only operators and admins search', async () => {
    expect((await http().get('/v1/admin/logs')).status).toBe(401);
    expect((await search('user')).status).toBe(403);
    expect((await search('editor')).status).toBe(403);
    expect((await search('operator')).status).toBe(200);
    expect((await search('admin')).status).toBe(200);
  });

  it('keeps request lines without secrets and finds them by requestId', async () => {
    const secret = 'tok_SUPERSECRET_123';
    const failed = await http().get(`/v1/me/settings?access_token=${secret}`).set('Authorization', `Bearer ${secret}`).set('X-Request-Id', 'req-trace-0001');
    expect(failed.status).toBe(401);
    await http().get('/health/live');
    await flush();

    const res = await search('operator', { requestId: 'req-trace-0001' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.retentionDays).toBe(14);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0]).toMatchObject({ severity: 'WARN', eventCode: 'HTTP_REQUEST', method: 'GET', status: 401, service: 'api', build: 'test' });
    expect(JSON.stringify(res.body)).not.toContain(secret);
    const { rows } = await t.pool.query('SELECT * FROM operational_logs');
    expect(JSON.stringify(rows)).not.toContain(secret);
    // Health probes stay on stdout only.
    expect(rows.some((r: { route: string }) => r.route?.startsWith('/health'))).toBe(false);
  });

  it('filters by severity and status and pages newest first', async () => {
    for (let i = 0; i < 5; i++) await http().get('/v1/me/settings');
    await flush();
    const first = await search('admin', { severity: 'WARN', status: '401', limit: '2' });
    expect(first.status).toBe(200);
    expect(first.body.logs).toHaveLength(2);
    expect(first.body.logs.every((l: { severity: string }) => l.severity === 'WARN')).toBe(true);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await search('admin', { severity: 'WARN', status: '401', limit: '2', cursor: first.body.nextCursor });
    expect(second.body.logs).toHaveLength(2);
    const rows = [...first.body.logs, ...second.body.logs] as { timestamp: string; id: string }[];
    for (let i = 1; i < rows.length; i++) {
      const [a, b] = [rows[i - 1], rows[i]];
      expect(a.timestamp > b.timestamp || (a.timestamp === b.timestamp && Number(a.id) > Number(b.id))).toBe(true);
    }
    expect(new Set([...first.body.logs, ...second.body.logs].map((l: { id: string }) => l.id)).size).toBe(4);
  });

  it('records every search in the audit trail', async () => {
    await search('operator', { eventCode: 'HTTP_REQUEST', severity: 'ERROR' });
    const { rows } = await t.pool.query(
      `SELECT a.actor, a.changes FROM audit_events a WHERE a.action = 'logs.search' ORDER BY a.id DESC LIMIT 1`,
    );
    const { rows: users } = await t.pool.query(`SELECT id FROM users WHERE oidc_subject = 'ops-1'`);
    expect(rows[0].actor).toBe(`user:${users[0].id}`);
    expect(rows[0].changes).toMatchObject({ eventCode: 'HTTP_REQUEST', severity: ['ERROR'] });
  });

  it('rejects unbounded or malformed filters', async () => {
    const cases: Record<string, string>[] = [
      { from: '2026-01-01T00:00:00Z', to: '2026-01-20T00:00:00Z' },
      { from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' },
      { severity: 'FATAL' },
      { service: 'billing' },
      { limit: '500' },
      { limit: '0' },
      { requestId: "x' OR 1=1 --" },
      { eventCode: 'drop table' },
      { cursor: 'bm90LWEtY3Vyc29y' },
      { from: 'yesterday' },
    ];
    for (const q of cases) {
      const res = await search('operator', q);
      expect([res.status, q]).toEqual([400, q]);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('defaults to the last hour', () => {
    const now = new Date('2026-10-03T12:00:00Z');
    const q = parseLogQuery({}, now);
    expect(q.to).toEqual(now);
    expect(q.from).toEqual(new Date('2026-10-03T11:00:00Z'));
    expect(q.limit).toBe(50);
  });

  it('drops old lines after the retention period', async () => {
    await t.pool.query(
      `INSERT INTO operational_logs (logged_at, severity, service, environment, build, event_code) VALUES (now() - interval '15 days', 'INFO', 'api', 'dev', 'test', 'OLD_LINE')`,
    );
    const store = t.app.get(PgLogStore) as unknown as { lastPrune: number };
    store.lastPrune = 0;
    await flush();
    const { rows } = await t.pool.query(`SELECT 1 FROM operational_logs WHERE event_code = 'OLD_LINE'`);
    expect(rows).toHaveLength(0);
  });

  it('keeps serving requests when the log table is unavailable', async () => {
    await t.pool.query('ALTER TABLE operational_logs RENAME TO operational_logs_off');
    try {
      t.logs.mark();
      expect((await http().get('/v1/me/settings')).status).toBe(401);
      await flush();
      expect(t.logs.lines().some((l) => l.eventCode === 'LOG_STORE_DROPPED')).toBe(true);
    } finally {
      await t.pool.query('ALTER TABLE operational_logs_off RENAME TO operational_logs');
    }
  });
});
