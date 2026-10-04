import request from 'supertest';
import { AccountService } from '../src/account/account';
import { Database } from '../src/db/database';
import { normalizeCode } from '../src/diagnostics/support-access';
import { runStaffCli } from '../src/staff/staff-cli';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

describe('support access to diagnostics, granted by the customer’s code (Doc 17)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());
  const bearer = async (sub: string) => ({ Authorization: `Bearer ${await id.token(sub)}` });
  const reason = 'ลูกค้าแจ้งว่าเล่นวิทยุไม่ได้ เคส #2001';

  /** A customer with one phone and one report holding two events. Returns their user id. */
  async function customer(sub: string): Promise<string> {
    const phone = crypto.randomUUID();
    await http().put(`/v1/me/devices/${phone}`).set(await bearer(sub)).send({ platform: 'ios', osMajor: 18, appBuild: '1.0.0+42' }).expect(200);
    const { rows: [u] } = await t.pool.query(`SELECT id FROM users WHERE oidc_subject = $1`, [sub]);
    const { rows: [r] } = await t.pool.query(
      `INSERT INTO diagnostic_reports (user_id, device_id, batch_id, consented, event_count) VALUES ($1, $2, gen_random_uuid(), true, 2) RETURNING id`,
      [u.id, phone],
    );
    await t.pool.query(
      `INSERT INTO diagnostic_events (report_id, user_id, event_id, event_name, schema_version, monotonic_ms, session_random_id, duration_ms, result_code, network_class, app_build, os_major, device_class)
       VALUES ($1, $2, gen_random_uuid(), 'playback_start', 1, 10, 'sess-random-1', 900, 'ok', 'cellular', '1.0.0+42', 18, 'phone'),
              ($1, $2, gen_random_uuid(), 'playback_error', 1, 20, 'sess-random-1', NULL, 'stream_timeout', 'cellular', '1.0.0+42', 18, 'phone')`,
      [r.id, u.id],
    );
    return u.id;
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
    const staff = (...args: string[]) => runStaffCli(args, new Database(t.pool), () => undefined);
    for (const sub of ['sa-support', 'sa-support-2', 'sa-ops']) await http().get('/v1/me/settings').set(await bearer(sub)).expect(200);
    expect(await staff('grant', 'sa-support', 'support', '--by', 'tar', '--reason', 'support desk')).toBe(0);
    expect(await staff('grant', 'sa-support-2', 'support', '--by', 'tar', '--reason', 'support desk')).toBe(0);
    expect(await staff('grant', 'sa-ops', 'operator', '--by', 'tar', '--reason', 'ops')).toBe(0);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('shows nothing until the customer’s code is entered, then only to the member who entered it', async () => {
    const userId = await customer('sa-nok');
    const support = await bearer('sa-support');
    await http().get(`/v1/admin/users/${userId}/diagnostics`).set(support).expect(403);
    const lookup = await http().post('/v1/admin/users/lookup').set(support).send({ query: userId, reason }).expect(200);
    expect(lookup.body.diagnostics).toEqual({ reportsLast7Days: 1, access: null });

    const made = await http().post('/v1/me/support-access/codes').set(await bearer('sa-nok')).expect(201);
    expect(made.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const life = new Date(made.body.expiresAt).getTime() - Date.now();
    expect(life).toBeGreaterThan(59 * 60_000);
    expect(life).toBeLessThanOrEqual(60 * 60_000);

    // Typed loosely, as people read it out.
    const granted = await http()
      .post(`/v1/admin/users/${userId}/diagnostics/access`)
      .set(support)
      .send({ code: ` ${made.body.code.toLowerCase().replace('-', ' ')} `, reason })
      .expect(201);
    const days = (new Date(granted.body.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);

    const seen = await http().get(`/v1/admin/users/${userId}/diagnostics`).set(support).expect(200);
    expect(seen.body.reports).toHaveLength(1);
    expect(seen.body.reports[0].items.map((e: { resultCode: string }) => e.resultCode)).toEqual(['ok', 'stream_timeout']);
    // No event or session ids for support.
    expect(JSON.stringify(seen.body)).not.toContain('sess-random-1');
    expect((await http().post('/v1/admin/users/lookup').set(support).send({ query: userId, reason }).expect(200)).body.diagnostics.access).toMatchObject({ id: granted.body.id });

    // A code works once, and only for the member who entered it.
    expect((await http().post(`/v1/admin/users/${userId}/diagnostics/access`).set(await bearer('sa-support-2')).send({ code: made.body.code, reason })).status).toBe(404);
    await http().get(`/v1/admin/users/${userId}/diagnostics`).set(await bearer('sa-support-2')).expect(403);
    // Operators are not support.
    await http().get(`/v1/admin/users/${userId}/diagnostics`).set(await bearer('sa-ops')).expect(403);

    const audit = await t.pool.query(`SELECT action, reason FROM audit_events WHERE action LIKE 'support.%' ORDER BY id`);
    expect(audit.rows.map((r) => r.action)).toEqual(['support.code_created', 'support.access_granted', 'support.diagnostics_read', 'support.access_refused']);
    expect(audit.rows[1].reason).toBe(reason);
  });

  it('lets the customer see and withdraw access, and refuses old, replaced and other customers’ codes', async () => {
    const userId = await customer('sa-ploy');
    const otherId = await customer('sa-other');
    const ploy = await bearer('sa-ploy');
    const support = await bearer('sa-support');

    const first = await http().post('/v1/me/support-access/codes').set(ploy).expect(201);
    const second = await http().post('/v1/me/support-access/codes').set(ploy).expect(201);
    const redeem = (who: string, code: string) => http().post(`/v1/admin/users/${who}/diagnostics/access`).set(support).send({ code, reason });
    expect((await redeem(userId, first.body.code)).status).toBe(404); // replaced by the second
    expect((await redeem(otherId, second.body.code)).status).toBe(404); // someone else's code
    expect((await redeem(userId, 'not a code')).status).toBe(400);
    expect((await http().post(`/v1/admin/users/${userId}/diagnostics/access`).set(support).send({ code: second.body.code })).status).toBe(400); // no reason

    const third = await http().post('/v1/me/support-access/codes').set(ploy).expect(201);
    await t.pool.query(`UPDATE support_access_codes SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [userId]);
    expect((await redeem(userId, third.body.code)).status).toBe(404);

    const fresh = await http().post('/v1/me/support-access/codes').set(ploy).expect(201);
    const granted = await redeem(userId, fresh.body.code).expect(201);
    const mine = await http().get('/v1/me/support-access').set(ploy).expect(200);
    expect(mine.body).toMatchObject({ grants: [{ id: granted.body.id }], codeMinutes: 60, accessDays: 7 });
    await http().get('/v1/me/support-access').set(await bearer('sa-other')).expect(200, { grants: [], codeMinutes: 60, accessDays: 7 });

    await http().delete(`/v1/me/support-access/${granted.body.id}`).set(await bearer('sa-other')).expect(404);
    await http().delete(`/v1/me/support-access/${granted.body.id}`).set(ploy).expect(204);
    await http().get(`/v1/admin/users/${userId}/diagnostics`).set(support).expect(403);
    expect((await http().get('/v1/me/support-access').set(ploy).expect(200)).body.grants).toEqual([]);
  });

  it('ends access after 7 days and with the account', async () => {
    const userId = await customer('sa-mai');
    const mai = await bearer('sa-mai');
    const support = await bearer('sa-support');
    const code = (await http().post('/v1/me/support-access/codes').set(mai).expect(201)).body.code;
    await http().post(`/v1/admin/users/${userId}/diagnostics/access`).set(support).send({ code, reason }).expect(201);
    await t.pool.query(`UPDATE support_access_grants SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [userId]);
    await http().get(`/v1/admin/users/${userId}/diagnostics`).set(support).expect(403);

    await http().post('/v1/me/support-access/codes').set(mai).expect(201);
    await http().delete('/v1/me/account').set({ Authorization: `Bearer ${await id.token('sa-mai', { authTime: Math.floor(Date.now() / 1000) })}` }).expect(202);
    await t.app.get(AccountService).processQueue();
    const left = await t.pool.query(
      `SELECT (SELECT count(*) FROM support_access_codes WHERE user_id = $1) + (SELECT count(*) FROM support_access_grants WHERE user_id = $1) AS n`,
      [userId],
    );
    expect(Number(left.rows[0].n)).toBe(0);
  });

  it('reads codes the way people type them', () => {
    expect(normalizeCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeCode('ABCD EFGH')).toBe('ABCDEFGH');
    expect(normalizeCode('ABCD-EFG0')).toBeNull(); // 0 is not in the alphabet
    expect(normalizeCode('ABC')).toBeNull();
    expect(normalizeCode(42)).toBeNull();
  });
});
