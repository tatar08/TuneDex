import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AccountService } from '../src/account/account';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

const event = () => ({
  eventId: randomUUID(),
  eventName: 'playback_stall',
  schemaVersion: 1,
  monotonicMs: 120_000,
  sessionRandomId: 'sess_ab12cd34',
  durationMs: 3200,
  resultCode: 'MEDIA_STALLED',
  networkClass: 'cellular',
  appBuild: '1.0.0+42',
  osMajor: 18,
  deviceClass: 'phone',
});

describe('account export and deletion', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());
  const now = () => Math.floor(Date.now() / 1000);
  const bearer = async (sub: string, authTime?: number) => ({ Authorization: `Bearer ${await id.token(sub, authTime === undefined ? {} : { authTime })}` });

  /** An account with settings, a phone and one diagnostic report. Returns the phone's id. */
  async function seed(sub: string): Promise<string> {
    const who = await bearer(sub);
    const device = randomUUID();
    await http().patch('/v1/me/settings').set(who).set('If-Match', '"0"').send({ theme: 'dark' }).expect(200);
    await http().put(`/v1/me/devices/${device}`).set(who).send({ platform: 'android', osMajor: 15, appBuild: '1.0.0+42' }).expect(200);
    await http().post('/v1/diagnostics/batches').set(who).send({ batchId: randomUUID(), deviceId: device, consent: true, events: [event()] }).expect(200);
    return device;
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('exports the account’s own data as a JSON download, and audits it', async () => {
    const device = await seed('acct-export');
    await seed('acct-export-other');
    const res = await http().get('/v1/me/export').set(await bearer('acct-export')).expect(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="tunedeck-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      format: 'tunedeck-account-export',
      version: 1,
      settings: { revision: 1, settings: { theme: 'dark' } },
      devices: [{ id: device, platform: 'android' }],
      diagnostics: [{ deviceId: device, eventCount: 1, events: [{ eventName: 'playback_stall', monotonicMs: 120000, resultCode: 'MEDIA_STALLED', networkClass: 'cellular' }] }],
      diagnosticsTruncated: false,
      staffRoles: [],
    });
    // Nothing from the other account, and nothing linking to the identity provider.
    expect(JSON.stringify(res.body)).not.toContain('acct-export-other');
    expect(JSON.stringify(res.body)).not.toContain('oidc');
    const audit = await t.pool.query(`SELECT actor FROM audit_events WHERE action = 'account.export'`);
    expect(audit.rows).toEqual([{ actor: `user:${res.body.account.id}` }]);
  });

  it('needs a sign-in from the last 5 minutes to delete', async () => {
    await seed('acct-stale');
    const res = await http().delete('/v1/me/account').set(await bearer('acct-stale', now() - 301));
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'REAUTH_REQUIRED', details: { maxAgeSeconds: 300 } });
    await http().get('/v1/me/settings').set(await bearer('acct-stale')).expect(200);
  });

  it('locks the account at once, purges its data, and reports progress by ticket', async () => {
    await seed('acct-delete');
    const fresh = await bearer('acct-delete', now());
    const { rows: [user] } = await t.pool.query(`SELECT id FROM users WHERE oidc_subject = 'acct-delete'`);

    const res = await http().delete('/v1/me/account').set(fresh).expect(202);
    expect(res.body).toEqual({ ticket: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), status: 'deleting' });
    // From the request on, the account cannot be used and its phone cannot check in.
    const blocked = await http().get('/v1/me/settings').set(fresh);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('ACCOUNT_DELETING');
    await http().delete('/v1/me/account').set(fresh).expect(403);

    await t.app.get(AccountService).processQueue();
    const status = await http().get(`/v1/account-deletions/${res.body.ticket}`).expect(200);
    expect(status.body).toMatchObject({ status: 'completed', completedAt: expect.any(String) });
    expect(new Date(status.body.deadline).getTime() - new Date(status.body.requestedAt).getTime()).toBe(30 * 86_400_000);

    for (const [table, column] of [['account_preferences', 'owner_id'], ['devices', 'user_id'], ['diagnostic_reports', 'user_id'], ['diagnostic_events', 'user_id'], ['staff_roles', 'user_id']]) {
      expect((await t.pool.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [user.id])).rows).toEqual([]);
    }
    // A tombstone stays for station history and the audit trail, with no link to the identity.
    const { rows: [tomb] } = await t.pool.query('SELECT status, oidc_subject, locale, deleted_at FROM users WHERE id = $1', [user.id]);
    expect(tomb).toMatchObject({ status: 'deleted', oidc_subject: `deleted:${user.id}`, locale: null });
    expect(tomb.deleted_at).not.toBeNull();
    const audit = await t.pool.query(`SELECT actor, action FROM audit_events WHERE target_type = 'account' AND target_id = $1 ORDER BY id`, [user.id]);
    expect(audit.rows).toEqual([
      { actor: `user:${user.id}`, action: 'account.delete_requested' },
      { actor: 'system:account-deletion', action: 'account.deleted' },
    ]);

    // A token from a sign-in before the request (a phone still holding one) cannot start a new account...
    const old = await http().get('/v1/me/devices').set(fresh);
    expect(old.status).toBe(403);
    expect(old.body.code).toBe('ACCOUNT_DELETING');
    // ...but signing in again afterwards starts a new, empty account.
    const again = await bearer('acct-delete', now() + 2);
    expect((await http().get('/v1/me/devices').set(again).expect(200)).body.devices).toEqual([]);
    expect((await http().get('/v1/me/settings').set(again).expect(200)).body.revision).toBe(0);
  });

  it('keeps retrying a failed purge and reports it as failed meanwhile', async () => {
    await seed('acct-retry');
    const res = await http().delete('/v1/me/account').set(await bearer('acct-retry', now())).expect(202);
    const service = t.app.get(AccountService);
    await service.processQueue(); // the request already started one pass; this waits for the queue to settle
    // Make the next purge fail, then put the request back in the queue.
    const { rows: [user] } = await t.pool.query(`SELECT user_id FROM account_deletions ORDER BY requested_at DESC LIMIT 1`);
    await t.pool.query(`UPDATE account_deletions SET status = 'pending', completed_at = NULL WHERE user_id = $1`, [user.user_id]);
    await t.pool.query(`UPDATE users SET status = 'deleting' WHERE id = $1`, [user.user_id]);
    await t.pool.query(`CREATE FUNCTION fail_purge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END; $$`);
    await t.pool.query(`CREATE TRIGGER fail_purge BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION fail_purge()`);
    try {
      expect(await service.processQueue()).toBe(0);
      expect((await http().get(`/v1/account-deletions/${res.body.ticket}`).expect(200)).body.status).toBe('failed');
    } finally {
      await t.pool.query('DROP TRIGGER fail_purge ON users');
      await t.pool.query('DROP FUNCTION fail_purge()');
    }
    expect(await service.processQueue()).toBe(1);
    expect((await http().get(`/v1/account-deletions/${res.body.ticket}`).expect(200)).body.status).toBe('completed');
  });

  it('answers 404 for an unknown or malformed ticket', async () => {
    await http().get(`/v1/account-deletions/${'a'.repeat(43)}`).expect(404);
    await http().get('/v1/account-deletions/short').expect(404);
  });
});
