import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Database } from '../src/db/database';
import { runStaffCli } from '../src/staff/staff-cli';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

describe('/v1/admin/users/lookup', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());
  const bearer = async (sub: string) => ({ Authorization: `Bearer ${await id.token(sub)}` });
  const reason = 'ลูกค้าแจ้งว่าตั้งค่าไม่ซิงก์ เคส #1042';
  let customer: string;
  const phone = randomUUID();
  const tablet = randomUUID();

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
    const staff = (...args: string[]) => runStaffCli(args, new Database(t.pool), () => undefined);
    for (const sub of ['users-support', 'users-ops']) await http().get('/v1/me/settings').set(await bearer(sub)).expect(200);
    expect(await staff('grant', 'users-support', 'support', '--by', 'tar', '--reason', 'support desk')).toBe(0);
    expect(await staff('grant', 'users-ops', 'operator', '--by', 'tar', '--reason', 'ops')).toBe(0);

    // A customer with two devices: the phone picked up the first save, the tablet has not checked in since.
    const who = { Authorization: `Bearer ${await id.token('users-customer', { email: 'Nok.Customer@example.com' })}` };
    await http().put(`/v1/me/devices/${tablet}`).set(who).send({ platform: 'android', osMajor: 14, appBuild: '1.0.0+40' }).expect(200);
    await http().patch('/v1/me/settings').set(who).set('If-Match', '"0"').send({ theme: 'dark' }).expect(200);
    await http().put(`/v1/me/devices/${phone}`).set(who).send({ platform: 'ios', osMajor: 18, appBuild: '1.0.0+42', appliedSettingsRevision: 1 }).expect(200);
    customer = (await t.pool.query(`SELECT id FROM users WHERE oidc_subject = 'users-customer'`)).rows[0].id;
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('is for support and admins only, needs a reason and an id', async () => {
    expect((await http().post('/v1/admin/users/lookup').send({ query: customer, reason })).status).toBe(401);
    expect((await http().post('/v1/admin/users/lookup').set(await bearer('users-ops')).send({ query: customer, reason })).status).toBe(403);
    const sup = await bearer('users-support');
    expect((await http().post('/v1/admin/users/lookup').set(sup).send({ query: customer })).body.details).toMatchObject({ field: 'reason' });
    expect((await http().post('/v1/admin/users/lookup').set(sup).send({ query: 'users-customer', reason })).body.details).toMatchObject({ field: 'query' });
  });

  it('finds an account by user or device id with minimal support data, and records every lookup', async () => {
    const sup = await bearer('users-support');
    const res = await http().post('/v1/admin/users/lookup').set(sup).send({ query: customer, reason }).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      matchedBy: 'user',
      user: { id: customer, email: 'Nok.Customer@example.com', emailVerified: true, status: 'active', deletedAt: null },
      settings: { revision: 1 },
      diagnostics: { reportsLast7Days: 0 },
      deletion: null,
    });
    const byId = Object.fromEntries(res.body.devices.map((d: { id: string }) => [d.id, d]));
    expect(byId[phone]).toMatchObject({ platform: 'ios', appliedSettingsRevision: 1, inSync: true, revokedAt: null });
    expect(byId[tablet]).toMatchObject({ platform: 'android', appliedSettingsRevision: 0, inSync: false });
    // No setting values, subject or roles leave the API.
    expect(JSON.stringify(res.body)).not.toMatch(/dark|users-customer|oidc|role/);
    const { rows: [stored] } = await t.pool.query('SELECT email, email_verified FROM users WHERE id = $1', [customer]);
    expect(stored).toEqual({ email: 'Nok.Customer@example.com', email_verified: true });

    const viaDevice = await http().post('/v1/admin/users/lookup').set(sup).send({ query: tablet.toUpperCase(), reason }).expect(200);
    expect(viaDevice.body).toMatchObject({ matchedBy: 'device', user: { id: customer } });
    expect((await http().post('/v1/admin/users/lookup').set(sup).send({ query: randomUUID(), reason })).status).toBe(404);
    // Email, any case, exact match only.
    const viaEmail = await http().post('/v1/admin/users/lookup').set(sup).send({ query: ' nok.customer@EXAMPLE.com ', reason }).expect(200);
    expect(viaEmail.body).toMatchObject({ matchedBy: 'email', user: { id: customer } });
    expect((await http().post('/v1/admin/users/lookup').set(sup).send({ query: 'nok@example.com', reason })).status).toBe(404);

    const audit = await t.pool.query(`SELECT target_id, reason, changes FROM audit_events WHERE action = 'user.lookup' ORDER BY id`);
    expect(audit.rows.map((r) => [r.target_id, r.changes.found])).toEqual([
      [customer, true],
      [customer, true],
      ['none', false],
      [customer, true],
      ['none', false],
    ]);
    expect(audit.rows.every((r) => r.reason === reason)).toBe(true);
    // The audit trail never holds the email that was searched for.
    expect(JSON.stringify(audit.rows)).not.toMatch(/example\.com/i);
  });
});
