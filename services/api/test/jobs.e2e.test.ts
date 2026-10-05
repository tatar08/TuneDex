import request from 'supertest';
import { AccountService } from '../src/account/account';
import { DevicesService } from '../src/devices/devices.service';
import { AlertService } from '../src/overview/alerts';
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
    expect(list.body.counts.retrying).toBe(1);
    const [job] = list.body.jobs;
    expect(job).toMatchObject({
      kind: 'account_deletion',
      status: 'retrying',
      attempts: 1,
      maxAttempts: 5,
      lastAttemptAt: expect.any(String),
      nextAttemptAt: expect.any(String),
      lastErrorCode: 'DB_P0001',
      deadline: expect.any(String),
    });
    expect(list.body.queues).toEqual([
      { kind: 'account_deletion', pending: 0, retrying: 1, deadLetter: 0, oldestOpenAt: job.requestedAt },
      { kind: 'account_export', pending: 0, retrying: 0, deadLetter: 0, oldestOpenAt: null },
      { kind: 'idp_session_end', pending: 0, retrying: 0, deadLetter: 0, oldestOpenAt: null },
    ]);
    expect(JSON.stringify(list.body)).not.toContain(u.id);

    // Right after an attempt a retry would only repeat it.
    const soon = await http().post(`/v1/admin/jobs/${job.id}/retry`).set(ops).send(reason);
    expect(soon.status).toBe(429);
    expect(soon.body.code).toBe('JOB_RETRY_TOO_SOON');

    await t.pool.query(`UPDATE account_deletions SET last_attempt_at = now() - interval '5 minutes'`);
    expect((await http().post(`/v1/admin/jobs/${job.id}/retry`).set(ops).send(reason).expect(200)).body).toEqual({ status: 'retrying' });

    await t.pool.query('DELETE FROM test_fail_purge');
    await t.pool.query(`UPDATE account_deletions SET last_attempt_at = now() - interval '5 minutes'`);
    expect((await http().post(`/v1/admin/jobs/${job.id}/retry`).set(ops).send(reason).expect(200)).body).toEqual({ status: 'completed' });
    expect((await t.pool.query('SELECT status FROM users WHERE id = $1', [u.id])).rows[0].status).toBe('deleted');

    // Idempotent: a finished job reports completed, runs nothing and records nothing more.
    expect((await http().post(`/v1/admin/jobs/${job.id}/retry`).set(ops).send(reason).expect(200)).body).toEqual({ status: 'completed' });
    const audit = await t.pool.query(`SELECT reason, changes FROM audit_events WHERE action = 'job.retry' AND target_id = $1 ORDER BY id`, [job.id]);
    expect(audit.rows.map((r) => r.changes.result)).toEqual(['retrying', 'completed']);
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
    // Leave the queue empty for the next tests.
    await t.pool.query('DELETE FROM test_fail_purge');
    await t.pool.query(`UPDATE account_deletions SET next_attempt_at = now() WHERE ticket_hash = $1`, [ticket_hash]);
    expect(await t.app.get(AccountService).processQueue()).toBe(1);
  });

  /** Runs the deletion worker until the request is dead-lettered, skipping each backoff wait. */
  async function exhaust(ticketHash: string) {
    for (let i = 0; i < 6; i++) {
      await t.pool.query(`UPDATE account_deletions SET next_attempt_at = now() WHERE ticket_hash = $1 AND status = 'failed'`, [ticketHash]);
      await t.app.get(AccountService).processQueue();
    }
  }
  const ago = (table: string, column: string) => t.pool.query(`UPDATE ${table} SET ${column} = ${column} - interval '5 minutes' WHERE ${column} IS NOT NULL`);

  it('dead-letters a deletion after 5 attempts, keeps the account locked and alerts, and caps staff retries at 3 a day', async () => {
    const leaver = await bearer('jobs-dead', now());
    await http().get('/v1/me/settings').set(leaver).expect(200);
    const { rows: [u] } = await t.pool.query(`SELECT id FROM users WHERE oidc_subject = 'jobs-dead'`);
    await t.pool.query('INSERT INTO test_fail_purge VALUES ($1)', [u.id]);
    const { ticket } = (await http().delete('/v1/me/account').set(leaver).expect(202)).body;
    await t.app.get(AccountService).processQueue();
    const [{ ticket_hash }] = (await t.pool.query(`SELECT ticket_hash FROM account_deletions WHERE user_id = $1`, [u.id])).rows;
    await exhaust(ticket_hash);

    const { rows: [row] } = await t.pool.query(`SELECT status, attempts, next_attempt_at, dead_lettered_at FROM account_deletions WHERE ticket_hash = $1`, [ticket_hash]);
    expect(row).toMatchObject({ status: 'dead_letter', attempts: 5, next_attempt_at: null, dead_lettered_at: expect.any(Date) });
    // The account stays locked and the user still reads "failed", within the 30-day deadline.
    expect((await t.pool.query('SELECT status FROM users WHERE id = $1', [u.id])).rows[0].status).toBe('deleting');
    expect((await http().get(`/v1/account-deletions/${ticket}`).expect(200)).body.status).toBe('failed');
    // The background run leaves it alone now.
    await t.pool.query(`UPDATE account_deletions SET next_attempt_at = now() WHERE ticket_hash = $1`, [ticket_hash]);
    await t.app.get(AccountService).processQueue();
    expect((await t.pool.query(`SELECT attempts FROM account_deletions WHERE ticket_hash = $1`, [ticket_hash])).rows[0].attempts).toBe(5);

    const ops = await bearer('jobs-ops');
    const list = await http().get('/v1/admin/jobs').query({ status: 'dead_letter' }).set(ops).expect(200);
    expect(list.body.jobs).toEqual([expect.objectContaining({ id: ticket_hash, status: 'dead_letter', attempts: 5, nextAttemptAt: null, lastErrorCode: 'DB_P0001' })]);
    expect(list.body.counts.dead_letter).toBe(1);
    expect(list.body.queues[0]).toMatchObject({ kind: 'account_deletion', deadLetter: 1 });

    const alerts = t.app.get(AlertService);
    await alerts.run(new Date());
    const open = (await t.pool.query(`SELECT code, value FROM alerts WHERE resolved_at IS NULL`)).rows;
    expect(open).toEqual(expect.arrayContaining([{ code: 'job_dead_letter', value: 1 }, { code: 'account_deletion_failed', value: 1 }]));
    // Dead letters are not "stuck": nothing is due.
    expect(open.map((a) => a.code)).not.toContain('account_deletion_stuck');

    // A staff retry starts a new round: the first attempt of it fails again, and it is retrying on the 1-minute step.
    await ago('account_deletions', 'last_attempt_at');
    expect((await http().post(`/v1/admin/jobs/${ticket_hash}/retry`).set(ops).send(reason).expect(200)).body).toEqual({ status: 'retrying' });
    expect((await t.pool.query(`SELECT status, attempts FROM account_deletions WHERE ticket_hash = $1`, [ticket_hash])).rows[0]).toEqual({ status: 'failed', attempts: 1 });
    for (let i = 0; i < 2; i++) {
      await ago('account_deletions', 'last_attempt_at');
      await http().post(`/v1/admin/jobs/${ticket_hash}/retry`).set(ops).send(reason).expect(200);
    }
    await ago('account_deletions', 'last_attempt_at');
    const capped = await http().post(`/v1/admin/jobs/${ticket_hash}/retry`).set(ops).send(reason);
    expect(capped.status).toBe(409);
    expect(capped.body).toMatchObject({ code: 'JOB_RETRY_LIMIT', details: { limit: 3, windowHours: 24 } });
    const audit = await t.pool.query(`SELECT changes FROM audit_events WHERE action = 'job.retry' AND target_id = $1 ORDER BY id`, [ticket_hash]);
    expect(audit.rows).toHaveLength(3);
    expect(audit.rows[0].changes).toMatchObject({ kind: 'account_deletion', stateBefore: 'dead_letter', attemptsBefore: 5, result: 'retrying' });

    // Once fixed, the background run finishes it when due, and the alerts resolve.
    await t.pool.query('DELETE FROM test_fail_purge');
    await t.pool.query(`UPDATE account_deletions SET next_attempt_at = now() WHERE ticket_hash = $1`, [ticket_hash]);
    expect(await t.app.get(AccountService).processQueue()).toBe(1);
    await alerts.run(new Date());
    expect((await t.pool.query(`SELECT code FROM alerts WHERE resolved_at IS NULL AND code IN ('job_dead_letter', 'account_deletion_failed')`)).rows).toEqual([]);
  });

  it('lists a dead-lettered export and Keycloak session end, and retries both', async () => {
    const user = await bearer('jobs-exporter', now());
    await http().get('/v1/me').set(user).expect(200);
    const { rows: [u] } = await t.pool.query(`SELECT id FROM users WHERE oidc_subject = 'jobs-exporter'`);
    const { rows: [exp] } = await t.pool.query(
      `INSERT INTO account_exports (user_id, status, attempts, last_attempt_at, last_error_code, dead_lettered_at, requested_at)
       VALUES ($1, 'dead_letter', 5, now() - interval '5 minutes', 'DB_57014', now(), now() - interval '2 hours') RETURNING id`,
      [u.id],
    );
    // A signed-out phone whose Keycloak session end keeps failing.
    const device = '7b0c1d2e-3f4a-4b5c-8d6e-7f8091a2b3c4';
    await http()
      .put(`/v1/me/devices/${device}`)
      .set({ Authorization: `Bearer ${await id.token('jobs-exporter', { sid: 'kc-jobs-phone' })}` })
      .send({ platform: 'ios', osMajor: 18, appBuild: '1.0.0+42', appliedSettingsRevision: 0 })
      .expect(200);
    t.idp.state.failSessions = true;
    try {
      await http().delete(`/v1/me/devices/${device}/session`).set(user).expect(200);
      for (let i = 0; i < 5; i++) {
        await t.pool.query(`UPDATE devices SET idp_session_next_attempt_at = now() WHERE idp_session_id = 'kc-jobs-phone' AND idp_session_dead_at IS NULL`);
        await t.app.get(DevicesService).retrySessionEnds();
      }
    } finally {
      t.idp.state.failSessions = false;
    }

    const ops = await bearer('jobs-ops');
    const list = await http().get('/v1/admin/jobs').set(ops).expect(200);
    const exportJob = list.body.jobs.find((j: { kind: string }) => j.kind === 'account_export');
    const sessionJob = list.body.jobs.find((j: { kind: string }) => j.kind === 'idp_session_end');
    expect(exportJob).toMatchObject({ id: `ex_${exp.id}`, status: 'dead_letter', attempts: 5, lastErrorCode: 'DB_57014', deadline: null });
    expect(sessionJob).toMatchObject({ id: expect.stringMatching(/^se_[0-9a-f]{64}$/), status: 'dead_letter', attempts: 5, lastErrorCode: 'IDP_SESSION_FAILED' });
    // No user id, device id or Keycloak session id on the page.
    for (const secret of [u.id, device, 'kc-jobs-phone']) expect(JSON.stringify(list.body)).not.toContain(secret);
    expect(list.body.queues.map((q: { kind: string; deadLetter: number }) => [q.kind, q.deadLetter])).toEqual([
      ['account_deletion', 0],
      ['account_export', 1],
      ['idp_session_end', 1],
    ]);

    expect((await http().post(`/v1/admin/jobs/${exportJob.id}/retry`).set(ops).send(reason).expect(200)).body).toEqual({ status: 'completed' });
    expect((await t.pool.query(`SELECT status, attempts FROM account_exports WHERE id = $1`, [exp.id])).rows[0]).toEqual({ status: 'ready', attempts: 1 });
    await ago('devices', 'idp_session_last_attempt_at');
    expect((await http().post(`/v1/admin/jobs/${sessionJob.id}/retry`).set(ops).send(reason).expect(200)).body).toEqual({ status: 'completed' });
    expect(t.idp.endedSessions).toContain('kc-jobs-phone');
    expect((await http().get('/v1/admin/jobs').set(ops).expect(200)).body.counts.dead_letter).toBe(0);
  });

  it('refuses to revive an export the account has already asked for again', async () => {
    const user = await bearer('jobs-again', now());
    await http().get('/v1/me').set(user).expect(200);
    const { rows: [u] } = await t.pool.query(`SELECT id FROM users WHERE oidc_subject = 'jobs-again'`);
    const { rows: [old] } = await t.pool.query(`INSERT INTO account_exports (user_id, status, attempts, dead_lettered_at) VALUES ($1, 'dead_letter', 5, now()) RETURNING id`, [u.id]);
    await t.pool.query(`INSERT INTO account_exports (user_id, claimed_at) VALUES ($1, now())`, [u.id]);
    const res = await http().post(`/v1/admin/jobs/ex_${old.id}/retry`).set(await bearer('jobs-ops')).send(reason);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JOB_SUPERSEDED');
  });

  it('alerts when a queue has had a job due for more than 5 minutes', async () => {
    const user = await bearer('jobs-stuck', now());
    await http().get('/v1/me').set(user).expect(200);
    const { rows: [u] } = await t.pool.query(`SELECT id FROM users WHERE oidc_subject = 'jobs-stuck'`);
    const { rows: [exp] } = await t.pool.query(`INSERT INTO account_exports (user_id, claimed_at, requested_at) VALUES ($1, now(), now() - interval '10 minutes') RETURNING id`, [u.id]);
    await t.app.get(AlertService).run(new Date());
    expect((await t.pool.query(`SELECT value FROM alerts WHERE code = 'account_export_stuck' AND resolved_at IS NULL`)).rows).toEqual([{ value: 1 }]);
    await t.pool.query('DELETE FROM account_exports WHERE id = $1', [exp.id]);
    await t.app.get(AlertService).run(new Date());
    expect((await t.pool.query(`SELECT 1 FROM alerts WHERE code = 'account_export_stuck' AND resolved_at IS NULL`)).rows).toEqual([]);
  });
});
