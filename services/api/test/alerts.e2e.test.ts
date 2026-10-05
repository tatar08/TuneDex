import request from 'supertest';
import { AlertService } from '../src/overview/alerts';
import { Database } from '../src/db/database';
import { runStaffCli } from '../src/staff/staff-cli';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

describe('Doc 17 alerts', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const posts: { url: string; text: string }[] = [];
  let webhookStatus = 200;
  const minutes = (n: number, from = Date.now()) => new Date(from + n * 60_000);

  /** Seeds request log rows `agoSec` before `at`, as the log sink would have written them. */
  async function requests(at: Date, rows: { status: number; durationMs: number; count: number }[]) {
    for (const r of rows) {
      await t.pool.query(
        `INSERT INTO operational_logs (logged_at, severity, service, environment, build, event_code, method, route, status, duration_ms)
         SELECT $1::timestamptz - (g * interval '1 second'), 'INFO', 'api', 'dev', 'test', 'HTTP_REQUEST', 'GET', '/v1/me/settings', $2, $3 FROM generate_series(1, $4) g`,
        [at, r.status, r.durationMs, r.count],
      );
    }
  }
  const alerts = () => t.app.get(AlertService);
  const open = async () => (await t.pool.query<{ code: string }>('SELECT code FROM alerts WHERE resolved_at IS NULL ORDER BY code')).rows.map((r) => r.code);

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver, {
      config: { alerts: { enabled: false, webhookUrl: 'https://hooks.example.test/T000/secret' } },
      alertFetch: async (url, init) => {
        posts.push({ url, text: JSON.parse(init.body).text });
        return { status: webhookStatus };
      },
    });
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('says nothing without enough traffic, fires on 5xx over 2% of 100+ requests, notifies once, then resolves', async () => {
    const t0 = new Date();
    await requests(t0, [{ status: 200, durationMs: 40, count: 30 }]);
    expect(await alerts().run(t0)).toBe(true);
    expect(await open()).toEqual([]);

    await requests(t0, [
      { status: 200, durationMs: 40, count: 100 },
      { status: 503, durationMs: 40, count: 5 },
    ]);
    t.logs.mark();
    await alerts().run(t0);
    expect(await open()).toEqual(['api_error_rate']);
    expect(t.logs.lines()).toContainEqual(expect.objectContaining({ eventCode: 'ALERT_FIRING', errorCode: 'api_error_rate', severity: 'ERROR' }));
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain('🔴');
    expect(posts[0].text).toContain('5xx 3.7%');
    expect(posts[0].text).not.toMatch(/req_|user|[0-9a-f]{8}-[0-9a-f]{4}/);
    // The webhook URL is a secret and never reaches the logs.
    expect(t.logs.raw()).not.toContain('hooks.example.test');

    // Still firing: no second message.
    await alerts().run(t0);
    expect(posts).toHaveLength(1);

    // Six minutes later the window holds only healthy traffic.
    const t1 = minutes(6, t0.getTime());
    await requests(t1, [{ status: 200, durationMs: 40, count: 120 }]);
    await alerts().run(t1);
    expect(await open()).toEqual([]);
    expect(posts.at(-1)!.text).toContain('✅');
  });

  it('a quiet window keeps an open alert open (missing data is not a pass)', async () => {
    const t0 = minutes(30);
    await requests(t0, [{ status: 500, durationMs: 40, count: 110 }]);
    await alerts().run(t0);
    expect(await open()).toEqual(['api_error_rate']);
    await alerts().run(minutes(45));
    expect(await open()).toEqual(['api_error_rate']);
    await requests(minutes(60), [{ status: 200, durationMs: 40, count: 110 }]);
    await alerts().run(minutes(60));
    expect(await open()).toEqual([]);
  });

  it('retries a notification the webhook refused', async () => {
    const before = posts.length;
    webhookStatus = 500;
    const t0 = minutes(120);
    await requests(t0, [{ status: 200, durationMs: 1500, count: 25 }]);
    t.logs.mark();
    await alerts().run(t0);
    expect(await open()).toEqual(['api_latency']);
    expect(t.logs.lines()).toContainEqual(expect.objectContaining({ eventCode: 'ALERT_NOTIFY_FAILED', errorCode: 'api_latency', status: 500 }));
    webhookStatus = 200;
    await alerts().run(t0);
    expect(posts.slice(before).filter((p) => p.text.includes('p95 1500 ms'))).toHaveLength(2);
  });

  it('flags a deletion queue that is stuck, and shows open alerts on the overview with when they started', async () => {
    const [{ id: userId }] = (await t.pool.query(`INSERT INTO users (oidc_subject, status) VALUES ('alert-stuck', 'deleting') RETURNING id`)).rows;
    await t.pool.query(`INSERT INTO account_deletions (ticket_hash, user_id, subject_hash, requested_at) VALUES ('h-alert', $1, 's', now() - interval '10 minutes')`, [userId]);
    await alerts().run(new Date());
    expect(await open()).toContain('account_deletion_stuck');

    await request(t.app.getHttpServer()).get('/v1/me/settings').set('Authorization', `Bearer ${await id.token('alert-ops')}`).expect(200);
    expect(await runStaffCli(['grant', 'alert-ops', 'operator', '--by', 'tar', '--reason', 'alerts'], new Database(t.pool), () => undefined)).toBe(0);
    const res = await request(t.app.getHttpServer()).get('/v1/admin/overview?window=1h').set('Authorization', `Bearer ${await id.token('alert-ops')}`).expect(200);
    const stuck = res.body.incidents.find((i: { code: string }) => i.code === 'account_deletion_stuck');
    expect(stuck).toMatchObject({ severity: 'warning', count: 1 });
    expect(typeof stuck.since).toBe('string');
  });

  it('fires on any dead letter across queues and on each queue whose oldest due job waits over 5 minutes', async () => {
    await t.pool.query(`DELETE FROM account_deletions`);
    const [{ id: userId }] = (await t.pool.query(`INSERT INTO users (oidc_subject) VALUES ('alert-queues') RETURNING id`)).rows;
    // A retrying deletion whose next try is still ahead is neither stuck nor dead.
    await t.pool.query(
      `INSERT INTO account_deletions (ticket_hash, user_id, subject_hash, status, attempts, next_attempt_at, requested_at)
       VALUES ('h-backoff', $1, 's', 'failed', 2, now() + interval '4 minutes', now() - interval '20 minutes')`,
      [userId],
    );
    // A signed-out phone whose Keycloak session end has been due for 10 minutes, and one dead-lettered.
    await t.pool.query(
      `INSERT INTO devices (user_id, id, platform, os_major, app_build, revoked_at, idp_session_id, idp_session_attempts, idp_session_next_attempt_at, idp_session_dead_at)
       VALUES ($1, '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d', 'ios', 18, '1', now() - interval '1 hour', 'kc-alert-1', 1, now() - interval '10 minutes', NULL),
              ($1, '1a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d', 'ios', 18, '1', now() - interval '2 hours', 'kc-alert-2', 5, NULL, now())`,
      [userId],
    );
    const before = posts.length;
    await alerts().run(new Date());
    const fired = await open();
    expect(fired).toEqual(expect.arrayContaining(['idp_session_end_stuck', 'job_dead_letter', 'account_deletion_failed']));
    expect(fired).not.toContain('account_deletion_stuck');
    expect(fired).not.toContain('account_export_stuck');
    const sent = posts.slice(before).map((p) => p.text).join('\n');
    expect(sent).toContain('[job_dead_letter]');
    expect(sent).toContain('[idp_session_end_stuck]');
    expect(sent).not.toMatch(/kc-alert|h-backoff|[0-9a-f]{8}-[0-9a-f]{4}/);

    await t.pool.query(`UPDATE devices SET idp_session_ended_at = now() WHERE user_id = $1`, [userId]);
    await t.pool.query(`DELETE FROM account_deletions WHERE user_id = $1`, [userId]);
    await alerts().run(new Date());
    expect((await open()).filter((c) => c.includes('session') || c.startsWith('job_') || c.startsWith('account_'))).toEqual([]);
  });

  it('warns while a visible station has rights ending within 14 days, never naming the station', async () => {
    const [{ id: author }] = (await t.pool.query(`SELECT id FROM users LIMIT 1`)).rows;
    const draft = { name: 'Rights Ending FM', country: 'TH', language: 'th', genres: ['jazz'], streamUrl: 'https://radio.test/r', codec: 'mp3', bitrateKbps: 128 };
    const add = async (endsInDays: number | null, disabled = false) =>
      (
        await t.pool.query(
          `INSERT INTO radio_stations (draft, created_by, updated_by, published, published_revision, published_by, published_at, rights_expires_at, disabled_at)
           VALUES ($1, $2, $2, $1, 1, $2, now(), CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(days => $3::int) END, CASE WHEN $4 THEN now() END) RETURNING id`,
          [draft, author, endsInDays, disabled],
        )
      ).rows[0].id as string;
    await add(60);
    await add(null);
    await add(5, true);
    await alerts().run(new Date());
    expect(await open()).not.toContain('station_rights_expiring');

    const soon = await add(5);
    const before = posts.length;
    await alerts().run(new Date());
    expect(await open()).toContain('station_rights_expiring');
    const [row] = (await t.pool.query(`SELECT value FROM alerts WHERE code = 'station_rights_expiring' AND resolved_at IS NULL`)).rows;
    expect(row.value).toBe(1);
    const sent = posts.slice(before).map((p) => p.text).join('\n');
    expect(sent).toContain('[station_rights_expiring]');
    expect(sent).not.toContain('Rights Ending FM');
    expect(sent).not.toContain(soon);

    // A renewed record moves the end out of the window and the alert resolves.
    await t.pool.query(`UPDATE radio_stations SET rights_expires_at = now() + interval '200 days' WHERE id = $1`, [soon]);
    await alerts().run(new Date());
    expect(await open()).not.toContain('station_rights_expiring');
  });

  it('alerts when the newest recorded backup is over 26 hours old, and stays quiet where backup.sh never ran', async () => {
    await alerts().run(new Date());
    expect(await open()).not.toContain('backup_stale');
    await t.pool.query(`INSERT INTO backup_runs (finished_at, tables, bytes) VALUES (now() - interval '30 hours', 30, 1000)`);
    await alerts().run(new Date());
    expect(await open()).toContain('backup_stale');
    expect((await t.pool.query(`SELECT severity, value FROM alerts WHERE code = 'backup_stale' AND resolved_at IS NULL`)).rows).toEqual([{ severity: 'critical', value: 30 }]);
    await t.pool.query(`INSERT INTO backup_runs (tables, bytes) VALUES (30, 1000)`);
    await alerts().run(new Date());
    expect(await open()).not.toContain('backup_stale');
  });
});
