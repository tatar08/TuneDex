import request from 'supertest';
import { AccountService } from '../src/account/account';
import { AccountExportsService } from '../src/account/exports';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

describe('account exports as jobs (Doc 17 POST /me/exports)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());
  const now = () => Math.floor(Date.now() / 1000);
  const bearer = async (sub: string, authTime?: number) => ({ Authorization: `Bearer ${await id.token(sub, authTime === undefined ? {} : { authTime })}` });

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('needs a recent sign-in, builds the export, and hands out a 15-minute link that works without signing in', async () => {
    const stale = await http().post('/v1/me/exports').set(await bearer('exp-alice', now() - 301));
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('REAUTH_REQUIRED');

    const alice = await bearer('exp-alice', now());
    const started = await http().post('/v1/me/exports').set(alice).expect(202);
    expect(started.body).toMatchObject({ id: expect.any(String), status: 'pending', readyAt: null });

    await t.app.get(AccountExportsService).processQueue();
    const ready = await http().get(`/v1/me/exports/${started.body.id}`).set(alice).expect(200);
    expect(ready.body).toMatchObject({ status: 'ready', readyAt: expect.any(String), download: { path: expect.stringMatching(/^\/v1\/export-downloads\/[A-Za-z0-9_-]{43}$/) } });
    const linkLife = new Date(ready.body.download.expiresAt).getTime() - Date.now();
    expect(linkLife).toBeGreaterThan(14 * 60_000);
    expect(linkLife).toBeLessThanOrEqual(15 * 60_000);

    const file = await http().get(ready.body.download.path).expect(200);
    expect(file.headers['content-disposition']).toMatch(/^attachment; filename="tunedeck-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.body).toMatchObject({ format: 'tunedeck-account-export', account: { id: expect.any(String) } });

    // A new read replaces the link; the old one stops working.
    const next = await http().get(`/v1/me/exports/${started.body.id}`).set(alice).expect(200);
    expect(next.body.download.path).not.toBe(ready.body.download.path);
    await http().get(ready.body.download.path).expect(404);
    await http().get(next.body.download.path).expect(200);

    const audit = await t.pool.query(`SELECT 1 FROM audit_events WHERE action = 'account.export'`);
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps exports private, and removes expired links and exports', async () => {
    const bob = await bearer('exp-bob', now());
    const job = await http().post('/v1/me/exports').set(bob).expect(202);
    await t.app.get(AccountExportsService).processQueue();
    // Another account cannot see it, and malformed ids look the same.
    await http().get(`/v1/me/exports/${job.body.id}`).set(await bearer('exp-mallory')).expect(404);
    await http().get('/v1/me/exports/not-a-uuid').set(bob).expect(404);
    await http().get('/v1/export-downloads/short').expect(404);

    const { body } = await http().get(`/v1/me/exports/${job.body.id}`).set(bob).expect(200);
    await t.pool.query(`UPDATE account_exports SET link_expires_at = now() - interval '1 second' WHERE id = $1`, [job.body.id]);
    await http().get(body.download.path).expect(404);

    await t.pool.query(`UPDATE account_exports SET expires_at = now() - interval '1 second' WHERE id = $1`, [job.body.id]);
    await http().get(`/v1/me/exports/${job.body.id}`).set(bob).expect(404);
    await t.app.get(AccountExportsService).processQueue();
    expect((await t.pool.query('SELECT 1 FROM account_exports WHERE id = $1', [job.body.id])).rows).toHaveLength(0);
  });

  it('retries a failed build with backoff up to five times, then dead-letters it and reports it failed', async () => {
    const carol = await bearer('exp-carol', now());
    const service = t.app.get(AccountExportsService);
    const spy = jest.spyOn(t.app.get(AccountService), 'export').mockRejectedValue(new Error('boom'));
    let job: request.Response;
    try {
      job = await http().post('/v1/me/exports').set(carol).expect(202);
      await service.processQueue();
      // Not due again until the backoff ends: 1, 5, 15, then 60 minutes.
      const waits: number[] = [];
      for (let i = 0; i < 6; i++) {
        await service.processQueue();
        const { rows: [r] } = await t.pool.query(`SELECT extract(epoch FROM next_attempt_at - now())::int AS wait FROM account_exports WHERE id = $1`, [job.body.id]);
        if (r.wait !== null) waits.push(Math.round(r.wait / 60));
        await t.pool.query(`UPDATE account_exports SET next_attempt_at = now() WHERE id = $1 AND next_attempt_at IS NOT NULL`, [job.body.id]);
        if (i === 0) {
          expect((await http().get(`/v1/me/exports/${job.body.id}`).set(carol).expect(200)).body.status).toBe('pending');
        }
      }
      expect(waits).toEqual([1, 5, 15, 60]);
      expect(spy).toHaveBeenCalledTimes(5);
    } finally {
      spy.mockRestore();
    }
    const { rows: [row] } = await t.pool.query(`SELECT status, attempts, last_error_code, dead_lettered_at FROM account_exports WHERE id = $1`, [job.body.id]);
    expect(row).toMatchObject({ status: 'dead_letter', attempts: 5, last_error_code: 'INTERNAL_ERROR', dead_lettered_at: expect.any(Date) });
    const res = await http().get(`/v1/me/exports/${job.body.id}`).set(carol).expect(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.download).toBeUndefined();
    // A new request starts over.
    const retry = await http().post('/v1/me/exports').set(carol).expect(202);
    expect(retry.body.id).not.toBe(job.body.id);
  });

  it('returns the export already being built instead of starting another', async () => {
    const erin = await bearer('exp-erin', now());
    await http().get('/v1/me').set(erin).expect(200);
    const { rows: [user] } = await t.pool.query(`SELECT id FROM users WHERE oidc_subject = 'exp-erin'`);
    // Claimed by another instance just now, so this one leaves it alone.
    const { rows: [pending] } = await t.pool.query(`INSERT INTO account_exports (user_id, claimed_at) VALUES ($1, now()) RETURNING id`, [user.id]);
    const res = await http().post('/v1/me/exports').set(erin).expect(202);
    expect(res.body).toMatchObject({ id: pending.id, status: 'pending' });
  });

  it('deletes exports with the account', async () => {
    const dan = await bearer('exp-dan', now());
    await http().post('/v1/me/exports').set(dan).expect(202);
    await t.app.get(AccountExportsService).processQueue();
    await http().delete('/v1/me/account').set(dan).expect(202);
    await t.app.get(AccountService).processQueue();
    const { rows } = await t.pool.query(`SELECT 1 FROM account_exports e JOIN users u ON u.id = e.user_id WHERE u.oidc_subject LIKE 'deleted:%'`);
    expect(rows).toHaveLength(0);
  });
});
