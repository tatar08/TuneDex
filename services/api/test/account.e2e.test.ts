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

  it('tells the signed-in customer their account id for support, and nothing more', async () => {
    expect((await http().get('/v1/me')).status).toBe(401);
    const res = await http().get('/v1/me').set({ Authorization: `Bearer ${await id.token('acct-me', { email: 'me@example.com' })}` }).expect(200);
    const { rows: [u] } = await t.pool.query(`SELECT id FROM users WHERE oidc_subject = 'acct-me'`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ userId: u.id, email: 'me@example.com', status: 'active', createdAt: expect.any(String) });
    // A changed address at the provider is picked up on the next request; a token without one keeps the last.
    await http().get('/v1/me').set({ Authorization: `Bearer ${await id.token('acct-me', { email: 'new@example.com', emailVerified: false })}` }).expect(200);
    expect((await http().get('/v1/me').set(await bearer('acct-me')).expect(200)).body.email).toBe('new@example.com');
  });

  it('exports the account’s own data as a JSON download, and audits it', async () => {
    const device = await seed('acct-export');
    await seed('acct-export-other');
    // An old sign-in is not enough to read everything.
    expect((await http().get('/v1/me/export').set(await bearer('acct-export', Math.floor(Date.now() / 1000) - 3600))).body.code).toBe('REAUTH_REQUIRED');
    const res = await http().get('/v1/me/export').set(await bearer('acct-export', Math.floor(Date.now() / 1000))).expect(200);
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
    expect((await http().delete('/v1/me').set('Idempotency-Key', crypto.randomUUID()).set(await bearer('acct-stale', now() - 301))).body.code).toBe('REAUTH_REQUIRED');
    expect(res.body).toMatchObject({ code: 'REAUTH_REQUIRED', details: { maxAgeSeconds: 300 } });
    await http().get('/v1/me/settings').set(await bearer('acct-stale')).expect(200);
  });

  it('locks the account at once, purges its data, and reports progress by ticket', async () => {
    await seed('acct-delete');
    const fresh = await bearer('acct-delete', now());
    await http().get('/v1/me').set({ Authorization: `Bearer ${await id.token('acct-delete', { email: 'leaver@example.com' })}` }).expect(200);
    const { rows: [user] } = await t.pool.query(`SELECT id FROM users WHERE oidc_subject = 'acct-delete'`);
    await t.pool.query(`INSERT INTO synced_entities (user_id, entity_id, type, revision, value) VALUES ($1, gen_random_uuid(), 'favorite', 1, '{"stationId":"00000000-0000-4000-8000-000000000000","order":0}')`, [user.id]);
    await t.pool.query(`INSERT INTO sync_changes (user_id, change_id, body_hash, result) VALUES ($1, gen_random_uuid(), 'h', '{}')`, [user.id]);
    await t.pool.query(`INSERT INTO sync_horizons (user_id, purged_seq) VALUES ($1, 1)`, [user.id]);

    const res = await http().delete('/v1/me/account').set(fresh).expect(202);
    expect(res.body).toEqual({ ticket: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), status: 'deleting' });
    // From the request on, the account cannot be used and its phone cannot check in.
    const blocked = await http().get('/v1/me/settings').set(fresh);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('ACCOUNT_DELETING');
    await http().delete('/v1/me/account').set(fresh).expect(403);
    // DELETE /v1/me is the Doc 17 path for the same request.
    await http().delete('/v1/me').set('Idempotency-Key', crypto.randomUUID()).set(fresh).expect(403);

    await t.app.get(AccountService).processQueue();
    const status = await http().get(`/v1/account-deletions/${res.body.ticket}`).expect(200);
    expect(status.body).toMatchObject({ status: 'completed', completedAt: expect.any(String) });
    expect(new Date(status.body.deadline).getTime() - new Date(status.body.requestedAt).getTime()).toBe(30 * 86_400_000);

    for (const [table, column] of [['account_preferences', 'owner_id'], ['devices', 'user_id'], ['diagnostic_reports', 'user_id'], ['diagnostic_events', 'user_id'], ['staff_roles', 'user_id'], ['synced_entities', 'user_id'], ['sync_changes', 'user_id'], ['sync_horizons', 'user_id']]) {
      expect((await t.pool.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [user.id])).rows).toEqual([]);
    }
    // A tombstone stays for station history and the audit trail, with no link to the identity.
    const { rows: [tomb] } = await t.pool.query('SELECT status, oidc_subject, locale, email, deleted_at FROM users WHERE id = $1', [user.id]);
    expect(tomb).toMatchObject({ status: 'deleted', oidc_subject: `deleted:${user.id}`, locale: null, email: null });
    expect(tomb.deleted_at).not.toBeNull();
    const audit = await t.pool.query(`SELECT actor, action FROM audit_events WHERE target_type = 'account' AND target_id = $1 ORDER BY id`, [user.id]);
    expect(audit.rows).toEqual([
      { actor: `user:${user.id}`, action: 'account.delete_requested' },
      { actor: 'system:account-deletion', action: 'account.deleted' },
    ]);
    // Tar's decision A: the Keycloak user goes too, by its id (the token subject).
    expect(t.idp.deleted).toContain('acct-delete');
    const { rows: [deletedEvent] } = await t.pool.query(`SELECT changes FROM audit_events WHERE action = 'account.deleted' AND target_id = $1`, [user.id]);
    expect(deletedEvent.changes).toEqual({ idpUser: 'deleted' });

    // A token from a sign-in before the request (a phone still holding one) cannot start a new account...
    const old = await http().get('/v1/me/devices').set(fresh);
    expect(old.status).toBe(403);
    expect(old.body.code).toBe('ACCOUNT_DELETING');
    // ...but signing in again afterwards starts a new, empty account.
    const again = await bearer('acct-delete', now() + 2);
    expect((await http().get('/v1/me/devices').set(again).expect(200)).body.devices).toEqual([]);
    expect((await http().get('/v1/me/settings').set(again).expect(200)).body.revision).toBe(0);
  });

  it('retries a failed purge once its backoff ends and reports it as failed meanwhile', async () => {
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
    // The next try waits for the first backoff step (1 minute), then runs.
    const { rows: [after] } = await t.pool.query(`SELECT status, attempts, last_error_code, extract(epoch FROM next_attempt_at - now()) AS wait FROM account_deletions WHERE user_id = $1`, [user.user_id]);
    expect(after).toMatchObject({ status: 'failed', last_error_code: 'DB_P0001' });
    expect(Number(after.wait)).toBeGreaterThan(50);
    expect(await service.processQueue()).toBe(0);
    await t.pool.query(`UPDATE account_deletions SET next_attempt_at = now() WHERE user_id = $1`, [user.user_id]);
    expect(await service.processQueue()).toBe(1);
    expect((await http().get(`/v1/account-deletions/${res.body.ticket}`).expect(200)).body.status).toBe('completed');
  });

  it('only completes once the Keycloak user is deleted, and keeps the account intact until then', async () => {
    await seed('acct-idp-down');
    t.idp.state.failDeletes = true;
    let ticket = '';
    try {
      ticket = (await http().delete('/v1/me/account').set(await bearer('acct-idp-down', now())).expect(202)).body.ticket;
      t.logs.mark();
      expect(await t.app.get(AccountService).processQueue()).toBe(0);
      expect((await http().get(`/v1/account-deletions/${ticket}`).expect(200)).body.status).toBe('failed');
      // Nothing local was removed: the next attempt starts over with the same identity.
      const { rows: [u] } = await t.pool.query(`SELECT id, status FROM users WHERE oidc_subject = 'acct-idp-down'`);
      expect(u.status).toBe('deleting');
      expect((await t.pool.query('SELECT 1 FROM account_preferences WHERE owner_id = $1', [u.id])).rows).toHaveLength(1);
      expect(t.logs.lines()).toContainEqual(expect.objectContaining({ eventCode: 'ACCOUNT_PURGE_FAILED', errorCode: 'IDP_DELETE_FAILED', status: 503 }));
      expect(t.logs.raw()).not.toContain('admin-token');
      expect(t.logs.raw()).not.toContain('test-only-secret');
    } finally {
      t.idp.state.failDeletes = false;
    }
    expect((await t.pool.query(`SELECT last_error_code FROM account_deletions WHERE status = 'failed'`)).rows).toEqual([{ last_error_code: 'IDP_DELETE_FAILED' }]);
    await t.pool.query(`UPDATE account_deletions SET next_attempt_at = now() WHERE status = 'failed'`);
    expect(await t.app.get(AccountService).processQueue()).toBe(1);
    expect((await http().get(`/v1/account-deletions/${ticket}`).expect(200)).body.status).toBe('completed');
    expect(t.idp.deleted).toContain('acct-idp-down');
  });

  it('treats a Keycloak user that is already gone as deleted, so a retry after a local failure completes', async () => {
    await seed('acct-idp-gone');
    t.idp.deleted.push('acct-idp-gone'); // removed at Keycloak by an earlier attempt or by hand
    const ticket = (await http().delete('/v1/me/account').set(await bearer('acct-idp-gone', now())).expect(202)).body.ticket;
    await t.app.get(AccountService).processQueue();
    expect((await http().get(`/v1/account-deletions/${ticket}`).expect(200)).body.status).toBe('completed');
    const { rows: [e] } = await t.pool.query(`SELECT changes FROM audit_events WHERE action = 'account.deleted' ORDER BY id DESC LIMIT 1`);
    expect(e.changes).toEqual({ idpUser: 'already_gone' });
  });

  it('answers 404 for an unknown or malformed ticket', async () => {
    await http().get(`/v1/account-deletions/${'a'.repeat(43)}`).expect(404);
    await http().get('/v1/account-deletions/short').expect(404);
  });
});
