import request from 'supertest';
import { AccountService } from '../src/account/account';
import { IdpUsersService } from '../src/account/idp-users';
import { runReconcileCli } from '../src/account/restore-reconcile-cli';
import { Database } from '../src/db/database';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

describe('after a restore, accounts whose Keycloak user is gone are deleted again', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());
  const lines: string[] = [];
  const cli = (...args: string[]) => runReconcileCli(args, new Database(t.pool), t.app.get(IdpUsersService), (l) => lines.push(l));
  const statusOf = async (sub: string) => (await t.pool.query<{ status: string }>('SELECT status FROM users WHERE oidc_subject = $1 OR id::text = $2', [sub, sub])).rows[0]?.status;

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
    for (let i = 0; i < 30; i++) await http().get('/v1/me/settings').set('Authorization', `Bearer ${await id.token(`restore-user-${i}`)}`).expect(200);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('reports without changing anything, refuses to act when Keycloak fails, then queues and purges with --apply', async () => {
    t.idp.deleted.push('restore-user-3');
    expect(await cli()).toBe(0);
    expect(lines.join('\n')).toContain('1 have no Keycloak user');
    expect(await statusOf('restore-user-3')).toBe('active');

    t.idp.state.failLookups = true;
    try {
      expect(await cli('--apply', '--by', 'tar', '--reason', 'restored from the nightly backup')).toBe(1);
      expect(lines.at(-1)).toContain('nothing changed');
    } finally {
      t.idp.state.failLookups = false;
    }
    expect(await statusOf('restore-user-3')).toBe('active');

    expect(await cli('--apply', '--by', 'tar')).toBe(2);
    expect(await cli('--apply', '--by', 'tar', '--reason', 'restored from the nightly backup')).toBe(0);
    expect(await statusOf('restore-user-3')).toBe('deleting');
    // Its old tokens no longer work, and the normal queue finishes the purge.
    expect((await http().get('/v1/me/settings').set('Authorization', `Bearer ${await id.token('restore-user-3')}`)).status).toBe(403);
    await t.app.get(AccountService).processQueue();
    const [row] = (await t.pool.query(`SELECT u.status FROM users u JOIN account_deletions d ON d.user_id = u.id WHERE d.status = 'completed'`)).rows;
    expect(row.status).toBe('deleted');
    const audit = (await t.pool.query(`SELECT actor, reason FROM audit_events WHERE action = 'account.restore_repurge'`)).rows;
    expect(audit).toEqual([{ actor: 'operator:tar', reason: 'restored from the nightly backup' }]);
    // Running it again finds nothing more.
    expect(await cli()).toBe(0);
    expect(lines.at(-1)).toContain('0 have no Keycloak user');
  });

  it('will not delete many accounts at once without --allow-many (a wrong realm looks like that)', async () => {
    for (let i = 10; i < 15; i++) t.idp.deleted.push(`restore-user-${i}`);
    expect(await cli('--apply', '--by', 'tar', '--reason', 'restored from the nightly backup')).toBe(1);
    expect(lines.at(-1)).toContain('Check that OIDC_ISSUER');
    expect(await statusOf('restore-user-10')).toBe('active');
    expect(await cli('--apply', '--by', 'tar', '--reason', 'restored from the nightly backup', '--allow-many')).toBe(0);
    expect(await statusOf('restore-user-10')).toBe('deleting');
  });
});
