import request from 'supertest';
import { parseAuditQuery } from '../src/audit/audit-search';
import { Database } from '../src/db/database';
import { runStaffCli } from '../src/staff/staff-cli';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

const station = {
  name: 'Audit FM',
  country: 'TH',
  language: 'th',
  genres: ['news'],
  streamUrl: 'https://stream.example.com/audit.mp3',
  codec: 'mp3',
  bitrateKbps: 128,
  rightsBasis: 'owner_permission',
  rightsReference: 'REF-AUDIT',
  rightsExpiresAt: null,
};

describe('audit trail search', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let tokens: Record<'auditor' | 'admin' | 'editor' | 'operator' | 'user', string>;
  let stationId: string;
  const http = () => request(t.app.getHttpServer());
  const as = (who: keyof typeof tokens) => ({ Authorization: `Bearer ${tokens[who]}` });
  const staff = (...args: string[]) => runStaffCli(args, new Database(t.pool), () => undefined);
  const search = (who: keyof typeof tokens, q: Record<string, string> = {}) => http().get('/v1/admin/audit').query(q).set(as(who));

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
    tokens = {
      auditor: await id.token('aud-1'),
      admin: await id.token('adm-1'),
      editor: await id.token('ed-1'),
      operator: await id.token('ops-1'),
      user: await id.token('usr-1'),
    };
    expect(await staff('grant', 'aud-1', 'auditor', '--by', 'tar', '--reason', 'audit')).toBe(0);
    expect(await staff('grant', 'adm-1', 'admin', '--by', 'tar', '--reason', 'admin')).toBe(0);
    expect(await staff('grant', 'ed-1', 'catalog_editor', '--by', 'tar', '--reason', 'catalog')).toBe(0);
    expect(await staff('grant', 'ops-1', 'operator', '--by', 'tar', '--reason', 'ops')).toBe(0);
    const created = await http().post('/v1/admin/stations').set(as('editor')).send(station);
    expect(created.status).toBe(201);
    stationId = created.body.id;
    const pub = await http().post(`/v1/admin/stations/${stationId}/publish`).set(as('admin')).set('If-Match', '"1"').send({ reason: 'checked rights letter' });
    expect(pub.status).toBe(200);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('lets only auditors and admins read the trail', async () => {
    expect((await http().get('/v1/admin/audit')).status).toBe(401);
    for (const who of ['user', 'editor', 'operator'] as const) expect((await search(who)).status).toBe(403);
    expect((await search('auditor')).status).toBe(200);
    expect((await search('admin')).status).toBe(200);
  });

  it('shows who did what, when and why, newest first', async () => {
    const res = await search('auditor');
    expect(res.headers['cache-control']).toBe('no-store');
    const actions = res.body.events.map((e: { action: string }) => e.action);
    expect(actions.slice(0, 2)).toEqual(['station.publish', 'station.create']);
    expect(actions.filter((a: string) => a.startsWith('staff_role.'))).toHaveLength(4);
    const publish = res.body.events[0];
    expect(publish).toMatchObject({ actorSubject: 'adm-1', targetLabel: 'Audit FM', targetType: 'station', targetId: stationId, reason: 'checked rights letter', changes: { revision: 1 } });
    const grant = res.body.events.find((e: { action: string }) => e.action === 'staff_role.grant');
    expect(grant).toMatchObject({ actor: 'operator:tar', actorSubject: null, targetLabel: expect.stringMatching(/^(aud|adm|ed|ops)-1$/), reason: expect.any(String) });
  });

  it('filters by actor subject, action family, target and pages', async () => {
    const mine = await search('admin', { actor: 'ed-1' });
    expect(mine.body.events.map((e: { action: string }) => e.action)).toEqual(['station.create']);
    const ops = await search('admin', { actor: 'operator:tar', action: 'staff_role' });
    expect(ops.body.events).toHaveLength(4);
    const target = await search('admin', { targetType: 'station', targetId: stationId });
    expect(target.body.events).toHaveLength(2);
    const first = await search('admin', { limit: '2' });
    expect(first.body.events).toHaveLength(2);
    const next = await search('admin', { limit: '2', cursor: first.body.nextCursor });
    expect(next.body.events[0].id).not.toBe(first.body.events[1].id);
    expect(Number(next.body.events[0].id)).toBeLessThan(Number(first.body.events[1].id));
  });

  it('records each read and hides reads unless asked', async () => {
    await search('auditor', { action: 'station' });
    const plain = await search('auditor');
    expect(plain.body.events.some((e: { action: string }) => e.action === 'audit.search')).toBe(false);
    const withReads = await search('auditor', { includeReads: '1', action: 'audit.search' });
    expect(withReads.body.events.length).toBeGreaterThan(0);
    expect(withReads.body.events.some((e: { actorSubject: string; changes: { action?: string } }) => e.actorSubject === 'aud-1' && e.changes.action === 'station')).toBe(true);
  });

  it('cannot change or delete what it shows', async () => {
    await expect(t.pool.query(`DELETE FROM audit_events`)).rejects.toThrow(/append-only/);
  });

  it('rejects unbounded or malformed filters', async () => {
    const cases: Record<string, string>[] = [
      { from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' },
      { from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' },
      { action: 'DROP TABLE' },
      { actor: "x' OR '1'='1" },
      { limit: '1000' },
      { cursor: 'bm9wZQ' },
    ];
    for (const q of cases) {
      const res = await search('auditor', q);
      expect([res.status, q]).toEqual([400, q]);
    }
  });

  it('defaults to the last 7 days', () => {
    const now = new Date('2026-10-03T00:00:00Z');
    const q = parseAuditQuery({}, now);
    expect(q.from).toEqual(new Date('2026-09-26T00:00:00Z'));
    expect(q.includeReads).toBe(false);
  });
});
