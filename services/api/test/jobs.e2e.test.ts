import request from 'supertest';
import { AccountService } from '../src/account/account';
import { Database } from '../src/db/database';
import { runStaffCli } from '../src/staff/staff-cli';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

describe('/v1/admin/jobs', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());
  const now = () => Math.floor(Date.now() / 1000);
  const bearer = async (sub: string, authTime?: number) => ({ Authorization: `Bearer ${await id.token(sub, authTime === undefined ? {} : { authTime })}` });
  const reason = { reason: 'purge failed overnight, retrying after fix' };

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
    const staff = (...args: string[]) => runStaffCli(args, new Database(t.pool), () => undefined);
    for (const sub of ['jobs-ops', 'jobs-editor']) await http().get('/v1/me/settings').set(await bearer(sub)).expect(200);
    expect(await staff('grant', 'jobs-ops', 'operator', '--by', 'tar', '--reason', 'ops')).toBe(0);
    expect(await staff('grant', 'jobs-editor', 'catalog_editor', '--by', 'tar', '--reason', 'catalog')).toBe(0);
    // Test-only switch that makes the purge of a listed user fail at its last step, so the transaction rolls back.
    await t.pool.query(`CREATE TABLE test_fail_purge (user_id uuid PRIMARY KEY)`);
    await t.pool.query(`CREATE FUNCTION test_fail_purge() RETURNS trigger AS $$
      BEGIN IF EXISTS (SELECT 1 FROM test_fail_purge WHERE user_id = NEW.id) THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await t.pool.query(`CREATE TRIGGER test_fail_purge BEFORE UPDATE ON users FOR EACH ROW WHEN (NEW.status = 'deleted') EXECUTE FUNCTION test_fail_purge()`);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('is for operators and admins only, and checks its input', async () => {
    expect((await http().get('/v1/admin/jobs')).status).toBe(401);
    expect((await http().get('/v1/admin/jobs').set(await bearer('jobs-editor'))).status).toBe(403);
    expect((await http().get('/v1/admin/jobs').query({ status: 'dead' }).set(await bearer('jobs-ops'))).status).toBe(400);
    const ops = await bearer('jobs-ops');
    expect((await http().post(`/v1/admin/jobs/${'a'.repeat(64)}/retry`).set(ops).send(reason)).status).toBe(404);
    expect((await http().post('/v1/admin/jobs/nope/retry').set(ops).send(reason)).status).toBe(404);
    expect((await http().post(`/v1/admin/jobs/${'a'.repeat(64)}/retry`).set(ops).send({ reason: 'short' })).body.details).toMatchObject({ field: 'reason' });
  });

  it('lists a failed deletion and lets an operator retry it once fixed, with the retry audited', async () => {
    const leaver = await bearer('jobs-leaver', now());
    await http().get('/v1/me/settings').set(leaver).expect(200);
    const { rows: [u] } = await t.pool.query(`SELECT id FROM users WHERE oidc_subject = 'jobs-leaver'`);
    await t.pool.query('INSERT INTO test_fail_purge VALUES ($1)', [u.id]);
    await http().delete('/v1/me/account').set(leaver).expect(202);
    await t.app.get(AccountService).processQueue();

    const ops = await bearer('jobs-ops');
    const list = await http().get('/v1/admin/jobs').set(ops).expect(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body.counts.failed).toBe(1);
    const [job] = list.body.jobs;
    expect(job).toMatchObject({ kind: 'account_deletion', status: 'failed', attempts: expect.any(Number), lastAttemptAt: expect.any(String) });
    expect(job.attempts).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(list.body)).not.toContain(u.id);

    // Right after an attempt a retry would only repeat it.
    const soon = await http().post(`/v1/admin/jobs/${job.id}/retry`).set(ops).send(reason);
    expect(soon.status).toBe(429);
    expect(soon.body.code).toBe('JOB_RETRY_TOO_SOON');

    await t.pool.query(`UPDATE account_deletions SET last_attempt_at = now() - interval '5 minutes'`);
    expect((await http().post(`/v1/admin/jobs/${job.id}/retry`).set(ops).send(reason).expect(200)).body).toEqual({ status: 'failed' });

    await t.pool.query('DELETE FROM test_fail_purge');
    await t.pool.query(`UPDATE account_deletions SET last_attempt_at = now() - interval '5 minutes'`);
    expect((await http().post(`/v1/admin/jobs/${job.id}/retry`).set(ops).send(reason).expect(200)).body).toEqual({ status: 'completed' });
    expect((await t.pool.query('SELECT status FROM users WHERE id = $1', [u.id])).rows[0].status).toBe('deleted');

    // Idempotent: a finished job reports completed, runs nothing and records nothing more.
    expect((await http().post(`/v1/admin/jobs/${job.id}/retry`).set(ops).send(reason).expect(200)).body).toEqual({ status: 'completed' });
    const audit = await t.pool.query(`SELECT reason, changes FROM audit_events WHERE action = 'job.retry' AND target_id = $1 ORDER BY id`, [job.id]);
    expect(audit.rows.map((r) => r.changes.result)).toEqual(['failed', 'completed']);
    expect(audit.rows[0].reason).toBe(reason.reason);

    const done = await http().get('/v1/admin/jobs').query({ status: 'completed' }).set(ops).expect(200);
    expect(done.body.jobs.map((j: { id: string }) => j.id)).toContain(job.id);
    expect((await http().get('/v1/admin/jobs').set(ops).expect(200)).body.jobs).toEqual([]);
  });

  it('reports a run already holding the queue as busy instead of purging twice', async () => {
    const leaver = await bearer('jobs-busy', now());
    await http().get('/v1/me/settings').set(leaver).expect(200);
    const { rows: [u] } = await t.pool.query(`SELECT id FROM users WHERE oidc_subject = 'jobs-busy'`);
    await t.pool.query('INSERT INTO test_fail_purge VALUES ($1)', [u.id]);
    await http().delete('/v1/me/account').set(leaver).expect(202);
    await t.app.get(AccountService).processQueue();
    await t.pool.query(`UPDATE account_deletions SET last_attempt_at = now() - interval '5 minutes'`);
    const [{ ticket_hash }] = (await t.pool.query(`SELECT ticket_hash FROM account_deletions WHERE user_id = $1`, [u.id])).rows;

    const holder = await t.pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(7421018)');
      const res = await http().post(`/v1/admin/jobs/${ticket_hash}/retry`).set(await bearer('jobs-ops')).send(reason);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('JOB_BUSY');
    } finally {
      await holder.query('SELECT pg_advisory_unlock(7421018)');
      holder.release();
    }
  });
});
