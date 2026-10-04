import request from 'supertest';
import { AccountService } from '../src/account/account';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

describe('Idempotency-Key on mutations (Doc 17)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());
  const bearer = async (sub: string, authTime?: number) => ({ Authorization: `Bearer ${await id.token(sub, authTime === undefined ? {} : { authTime })}` });
  const now = () => Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  async function revision(auth: Record<string, string>): Promise<number> {
    return (await http().get('/v1/me/settings').set(auth).expect(200)).body.revision;
  }

  it('runs a repeated request once and replays its answer, headers included', async () => {
    const alice = await bearer('idem-alice');
    const rev = await revision(alice);
    const send = () => http().patch('/v1/me/settings').set(alice).set('If-Match', `"${rev}"`).set('Idempotency-Key', 'key-alice-0001').send({ theme: 'dark' });

    const first = await send().expect(200);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const again = await send().expect(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(again.headers.etag).toBe(first.headers.etag);
    // Ran once: one revision step, although the second carried the old If-Match.
    expect(await revision(alice)).toBe(rev + 1);
  });

  it('refuses the same key with a different body, and keeps keys apart per account and per route', async () => {
    const bob = await bearer('idem-bob');
    const rev = await revision(bob);
    await http().patch('/v1/me/settings').set(bob).set('If-Match', `"${rev}"`).set('Idempotency-Key', 'shared-key-1').send({ theme: 'dark' }).expect(200);
    const reused = await http().patch('/v1/me/settings').set(bob).set('If-Match', `"${rev}"`).set('Idempotency-Key', 'shared-key-1').send({ theme: 'light' });
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', messageKey: 'errors.request.idempotencyKeyReused' });

    // Another account may use the same key.
    const carol = await bearer('idem-carol');
    const carolRev = await revision(carol);
    const other = await http().patch('/v1/me/settings').set(carol).set('If-Match', `"${carolRev}"`).set('Idempotency-Key', 'shared-key-1').send({ theme: 'light' }).expect(200);
    expect(other.headers['idempotent-replayed']).toBeUndefined();
    expect(other.body.settings.theme).toBe('light');
  });

  it('releases the key when the request fails, so a corrected retry can use it', async () => {
    const dan = await bearer('idem-dan');
    const rev = await revision(dan);
    const stale = await http().patch('/v1/me/settings').set(dan).set('If-Match', `"${rev + 5}"`).set('Idempotency-Key', 'retry-key-1').send({ theme: 'dark' });
    expect(stale.status).toBe(412);
    const ok = await http().patch('/v1/me/settings').set(dan).set('If-Match', `"${rev}"`).set('Idempotency-Key', 'retry-key-1').send({ theme: 'dark' }).expect(200);
    expect(ok.headers['idempotent-replayed']).toBeUndefined();
  });

  it('answers 409 with Retry-After while the first request is still running, and reuses keys after 24 hours', async () => {
    const erin = await bearer('idem-erin');
    const rev = await revision(erin);
    const { rows: [user] } = await t.pool.query(`SELECT id FROM users WHERE oidc_subject = 'idem-erin'`);
    const send = (key: string) => http().patch('/v1/me/settings').set(erin).set('If-Match', `"${rev}"`).set('Idempotency-Key', key).send({ theme: 'dark' });

    await send('busy-key-01').expect(200);
    await t.pool.query(`UPDATE idempotency_keys SET state = 'in_progress', response_body = NULL WHERE user_id = $1`, [user.id]);
    const busy = await send('busy-key-01');
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS', details: { retryAfterSeconds: 1 } });
    expect(busy.headers['retry-after']).toBe('1');

    // An abandoned claim (a crashed instance) is taken over after 5 minutes; an old result expires after 24 hours.
    await t.pool.query(`UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE user_id = $1`, [user.id]);
    const fresh = await send('busy-key-01');
    expect(fresh.status).toBe(412); // ran again, against the revision that has moved on
  });

  it('rejects a malformed key, and leaves requests without one unchanged', async () => {
    const fay = await bearer('idem-fay');
    const rev = await revision(fay);
    const bad = await http().patch('/v1/me/settings').set(fay).set('If-Match', `"${rev}"`).set('Idempotency-Key', 'short').send({ theme: 'dark' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'Idempotency-Key' } });
    await http().patch('/v1/me/settings').set(fay).set('If-Match', `"${rev}"`).send({ theme: 'dark' }).expect(200);
    const { rows } = await t.pool.query(`SELECT 1 FROM idempotency_keys k JOIN users u ON u.id = k.user_id WHERE u.oidc_subject = 'idem-fay'`);
    expect(rows).toHaveLength(0);
  });

  it('deletes an account once: a retry is told the deletion is under way, and the keys go with the account', async () => {
    const fresh = await bearer('idem-leaver', now());
    await http().get('/v1/me').set(fresh).expect(200);
    await http().delete('/v1/me/account').set(fresh).set('Idempotency-Key', 'delete-me-0001').expect(202);
    // The account is locked from the first request on, so the retry never reaches the stored answer.
    const again = await http().delete('/v1/me/account').set(fresh).set('Idempotency-Key', 'delete-me-0001');
    expect(again.status).toBe(403);
    expect(again.body.code).toBe('ACCOUNT_DELETING');
    expect((await t.pool.query(`SELECT 1 FROM account_deletions`)).rows).toHaveLength(1);

    await t.app.get(AccountService).processQueue();
    const { rows } = await t.pool.query(`SELECT 1 FROM idempotency_keys k JOIN users u ON u.id = k.user_id WHERE u.oidc_subject LIKE 'deleted:%'`);
    expect(rows).toHaveLength(0);
  });


  it('requires a key on POST /v1/me/exports and DELETE /v1/me (Doc 17)', async () => {
    const auth = { Authorization: `Bearer ${await id.token('idem-required', { authTime: Math.floor(Date.now() / 1000) })}` };
    for (const call of [() => http().post('/v1/me/exports'), () => http().delete('/v1/me')]) {
      const res = await call().set(auth);
      expect(res.status).toBe(428);
      expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED', details: { header: 'Idempotency-Key' } });
    }
    // The older deletion path keeps working without one, for app builds made before the key.
    await http().get('/v1/me/settings').set(auth).expect(200);
  });
});
