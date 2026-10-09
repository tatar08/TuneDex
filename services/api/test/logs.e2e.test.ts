import request from 'supertest';
import { Database } from '../src/db/database';
import { PgLogStore } from '../src/logs/log-store';
import { parseTraceparent } from '../src/common/request-context';
import { parseLogQuery, toCsv } from '../src/logs/logs';
import { runStaffCli } from '../src/staff/staff-cli';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

describe('operational logs', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let tokens: Record<'operator' | 'admin' | 'editor' | 'user', string>;
  /** The same database behind an app that demands staff MFA and counts rate limits. */
  let mfaApp: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());
  const as = (who: keyof typeof tokens) => ({ Authorization: `Bearer ${tokens[who]}` });
  const staff = (...args: string[]) => runStaffCli(args, new Database(t.pool), () => undefined);
  const flush = () => t.app.get(PgLogStore).flush();
  const search = (who: keyof typeof tokens, q: Record<string, string> = {}) => http().get('/v1/admin/logs').query(q).set(as(who));

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
    mfaApp = await createTestApp(db.url, id.keyResolver, {
      config: { staffMfaAcr: ['2'], rateLimit: { enabled: true, readsPerMinute: 120, writesPerMinute: 30, catalogPerMinutePerIp: 60, trustProxyHops: 0 } },
    });
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
    await mfaApp.close();
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
    // Newest first, ties broken by id; comparing whole lists shows the rows if the order is ever wrong.
    const newestFirst = [...rows].sort((a, b) => b.timestamp.localeCompare(a.timestamp) || Number(b.id) - Number(a.id));
    expect(rows.map((r) => `${r.timestamp} #${r.id}`)).toEqual(newestFirst.map((r) => `${r.timestamp} #${r.id}`));
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
      // Doc 17: at most 24 hours per query.
      { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:01Z' },
      { from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' },
      { severity: 'FATAL' },
      { service: 'billing' },
      { limit: '500' },
      { limit: '101' },
      { limit: '0' },
      { traceId: 'ABCDEF0123456789ABCDEF0123456789' },
      { traceId: '0123' },
      { errorCode: 'has space' },
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

  it('defaults to the last hour and 50 lines, and allows a full day of up to 100 lines a page', async () => {
    const now = new Date('2026-10-03T12:00:00Z');
    const q = parseLogQuery({}, now);
    expect(q.to).toEqual(now);
    expect(q.from).toEqual(new Date('2026-10-03T11:00:00Z'));
    expect(q.limit).toBe(50);
    const day = parseLogQuery({ from: '2026-10-02T12:00:00Z', to: '2026-10-03T12:00:00Z', limit: '100' }, now);
    expect(day.limit).toBe(100);
    const to = new Date();
    const res = await search('operator', { from: new Date(to.getTime() - 24 * 3600_000).toISOString(), to: to.toISOString(), limit: '100' });
    expect(res.status).toBe(200);
  });

  describe('trace context', () => {
    const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
    const OTHER_TRACE = '5cf92f3577b34da6a3ce929d0e0e4736';
    const PARENT = '00f067aa0ba902b7';

    it('joins a valid inbound traceparent and answers with its own span in the same trace', async () => {
      t.logs.mark();
      const res = await http().get('/v1/me/settings').set('traceparent', `00-${TRACE}-${PARENT}-01`).set('X-Request-Id', 'req-traceparent-01');
      const [, traceId, spanId, flags] = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(res.headers.traceparent)!;
      expect([traceId, flags]).toEqual([TRACE, '01']);
      expect(spanId).not.toBe(PARENT);
      expect(t.logs.lines().find((l) => l.requestId === 'req-traceparent-01')).toMatchObject({ eventCode: 'HTTP_REQUEST', traceId: TRACE });
      await flush();
      const found = await search('operator', { traceId: TRACE });
      expect(found.body.logs).toHaveLength(1);
      expect(found.body.logs[0]).toMatchObject({ requestId: 'req-traceparent-01', traceId: TRACE });
      const { rows } = await t.pool.query(`SELECT trace_id FROM operational_logs WHERE request_id = 'req-traceparent-01'`);
      expect(rows[0].trace_id).toBe(TRACE);
    });

    it('starts a new trace when traceparent is missing or invalid', async () => {
      const invalid = [
        undefined,
        'garbage',
        `ff-${TRACE}-${PARENT}-01`,
        `00-${'0'.repeat(32)}-${PARENT}-01`,
        `00-${TRACE}-${'0'.repeat(16)}-01`,
        `00-${TRACE.toUpperCase()}-${PARENT}-01`,
        `00-${TRACE}-${PARENT}-01-extra`,
      ];
      const seen = new Set<string>();
      for (const header of invalid) {
        const req = http().get('/health/live');
        const res = header === undefined ? await req : await req.set('traceparent', header);
        const m = /^00-([0-9a-f]{32})-[0-9a-f]{16}-01$/.exec(res.headers.traceparent);
        expect([header, m !== null && m[1] !== TRACE]).toEqual([header, true]);
        seen.add(m![1]);
      }
      expect(seen.size).toBe(invalid.length);
      // A later version is read by its version-00 fields.
      expect(parseTraceparent(`01-${TRACE}-${PARENT}-00-future`)).toEqual({ traceId: TRACE, parentId: PARENT, flags: '00' });
    });

    it('puts the trace id on lines logged while serving the request, after the body is read', async () => {
      const token = await id.token('trace-body');
      await mfaApp.pool.query('ALTER TABLE rate_limit_counters RENAME TO rate_limit_counters_off');
      try {
        mfaApp.logs.mark();
        await request(mfaApp.app.getHttpServer())
          .patch('/v1/me/settings')
          .set('Authorization', `Bearer ${token}`)
          .set('If-Match', '"0"')
          .set('traceparent', `00-${OTHER_TRACE}-${PARENT}-00`)
          .send({ theme: 'dark' });
        const lines = mfaApp.logs.lines();
        expect(lines.find((l) => l.eventCode === 'RATE_LIMIT_UNAVAILABLE')).toMatchObject({ traceId: OTHER_TRACE });
        expect(lines.find((l) => l.eventCode === 'HTTP_REQUEST')).toMatchObject({ traceId: OTHER_TRACE });
      } finally {
        await mfaApp.pool.query('ALTER TABLE rate_limit_counters_off RENAME TO rate_limit_counters');
      }
    });
  });

  it('filters by errorCode', async () => {
    await t.pool.query(
      `INSERT INTO operational_logs (logged_at, severity, service, environment, build, event_code, error_code)
       VALUES (now() - interval '1 minute', 'WARN', 'api', 'dev', 'test', 'IDP_SESSION_END_FAILED', 'IDP_SESSION_FAILED'),
              (now() - interval '1 minute', 'ERROR', 'api', 'dev', 'test', 'UNHANDLED_ERROR', '23505')`,
    );
    const res = await search('operator', { errorCode: 'IDP_SESSION_FAILED' });
    expect(res.body.logs.map((l: { eventCode: string }) => l.eventCode)).toEqual(['IDP_SESSION_END_FAILED']);
    expect((await search('operator', { errorCode: '23505' })).body.logs).toHaveLength(1);
    const { rows } = await t.pool.query(`SELECT changes FROM audit_events WHERE action = 'logs.search' ORDER BY id DESC LIMIT 1`);
    expect(rows[0].changes).toMatchObject({ errorCode: '23505' });
  });

  describe('export', () => {
    const reason = { reason: 'Incident review for ticket 42' };
    const exportAs = (who: keyof typeof tokens, body: object, q: Record<string, string> = {}) => http().post('/v1/admin/logs/export').query(q).set(as(who)).send(body);

    it('downloads the search as CSV and audits the reason, filters and row count, not the lines', async () => {
      await flush();
      t.logs.mark();
      const res = await exportAs('operator', reason, { status: '401', severity: 'WARN' });
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="tunedeck-logs-\d{4}-\d{2}-\d{2}\.csv"$/);
      const lines = res.text.replace(/^\uFEFF/, '').trim().split('\r\n');
      expect(lines[0]).toBe('id,timestamp,severity,service,environment,build,eventCode,requestId,traceId,method,route,status,durationMs,actorId,errorName,errorCode');
      expect(lines.length).toBeGreaterThan(5);
      expect(lines.slice(1).every((l) => l.includes(',WARN,') && l.includes(',401,'))).toBe(true);
      const { rows } = await t.pool.query(`SELECT actor, reason, changes FROM audit_events WHERE action = 'logs.export' ORDER BY id DESC LIMIT 1`);
      const { rows: users } = await t.pool.query(`SELECT id FROM users WHERE oidc_subject = 'ops-1'`);
      expect(rows[0]).toMatchObject({ actor: `user:${users[0].id}`, reason: reason.reason, changes: { status: 401, severity: ['WARN'], rows: lines.length - 1 } });
      // Only the export request's own line is logged.
      expect(t.logs.lines().map((l) => l.eventCode)).toEqual(['HTTP_REQUEST']);
    });

    it('needs the operator or admin role, a real reason and the same bounds as search', async () => {
      expect((await http().post('/v1/admin/logs/export').send(reason)).status).toBe(401);
      expect((await exportAs('editor', reason)).status).toBe(403);
      expect((await exportAs('user', reason)).status).toBe(403);
      expect((await exportAs('admin', reason)).status).toBe(200);
      for (const body of [{}, { reason: 'short' }, { reason: 'x'.repeat(501) }, { reason: 'tab\there is not ok' }]) {
        const res = await exportAs('admin', body);
        expect([res.status, res.body.details?.field]).toEqual([400, 'reason']);
      }
      const long = await exportAs('admin', reason, { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' });
      expect([long.status, long.body.details]).toEqual([400, { field: 'from', reason: 'window_too_long' }]);
    });

    it('refuses more than 10,000 lines so the search can be narrowed', async () => {
      await t.pool.query(
        `INSERT INTO operational_logs (logged_at, severity, service, environment, build, event_code)
         SELECT now() - interval '2 minutes', 'INFO', 'api', 'dev', 'test', 'BULK_LINE' FROM generate_series(1, 10001)`,
      );
      const res = await exportAs('admin', reason, { eventCode: 'BULK_LINE' });
      expect([res.status, res.body.details]).toEqual([400, { field: 'from', reason: 'too_many_rows' }]);
      await t.pool.query(`DELETE FROM operational_logs WHERE event_code = 'BULK_LINE'`);
    });

    it('asks for MFA from the last 5 minutes', async () => {
      const now = Math.floor(Date.now() / 1000);
      const exp = async (o: { authTime?: number; acr?: string }) =>
        request(mfaApp.app.getHttpServer()).post('/v1/admin/logs/export').set('Authorization', `Bearer ${await id.token('ops-1', o)}`).send(reason);
      const plain = await exp({ authTime: now });
      expect([plain.status, plain.body.code]).toEqual([401, 'MFA_REQUIRED']);
      expect((await exp({ authTime: now - 600, acr: '2' })).body.code).toBe('MFA_REQUIRED');
      expect((await exp({ authTime: now, acr: '2' })).status).toBe(200);
      // Searching needs an MFA sign-in, but not a fresh one.
      expect((await request(mfaApp.app.getHttpServer()).get('/v1/admin/logs').set('Authorization', `Bearer ${await id.token('ops-1', { authTime: now - 3600, acr: '2' })}`)).status).toBe(200);
    });

    it('neutralises cells a spreadsheet would run as formulas', () => {
      const csv = toCsv([
        { id: '1', timestamp: '2026-10-04T00:00:00.000Z', severity: 'ERROR', service: 'api', environment: 'dev', build: '=1+1', eventCode: 'X', requestId: null, traceId: null, method: null, route: '/a,b', status: 500, durationMs: 3, actorId: null, errorName: '@SUM', errorCode: null },
      ]);
      const row = csv.split('\r\n')[1];
      expect(row).toContain(`,'=1+1,`);
      expect(row).toContain(`,"/a,b",`);
      expect(row).toContain(`,'@SUM,`);
    });
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
