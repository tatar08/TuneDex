import { createPublicKey } from 'node:crypto';
import { compactVerify, decodeProtectedHeader } from 'jose';
import request from 'supertest';
import { CONFIG_SIGNER, ConfigSigner } from '../src/app-config/app-config';
import { Database } from '../src/db/database';
import { runStaffCli } from '../src/staff/staff-cli';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

describe('remote app config (/v1/config, /v1/admin/config)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());
  const bearer = async (sub: string) => ({ Authorization: `Bearer ${await id.token(sub)}` });
  const reason = { reason: 'iOS build 41 crashes on import, require 42' };

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
    const staff = (...args: string[]) => runStaffCli(args, new Database(t.pool), () => undefined);
    for (const sub of ['cfg-admin-a', 'cfg-admin-b', 'cfg-ops', 'cfg-editor', 'cfg-customer']) await http().get('/v1/me/settings').set(await bearer(sub)).expect(200);
    for (const [sub, role] of [['cfg-admin-a', 'admin'], ['cfg-admin-b', 'admin'], ['cfg-ops', 'operator'], ['cfg-editor', 'catalog_editor']]) {
      expect(await staff('grant', sub, role, '--by', 'tar', '--reason', 'config tests')).toBe(0);
    }
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  /** Verifies the JWS the way an app would: with the pinned public key, then reads only the signed payload. */
  async function verified(jws: string) {
    const signer = t.app.get<ConfigSigner>(CONFIG_SIGNER);
    const { payload, protectedHeader } = await compactVerify(jws, createPublicKey(signer.publicKeyPem));
    expect(protectedHeader).toEqual({ alg: 'EdDSA', kid: signer.keyId, typ: 'tunedeck-config+jws' });
    return JSON.parse(new TextDecoder().decode(payload));
  }

  it('serves signed defaults as release 0 before anything is published, without sign-in', async () => {
    const res = await http().get('/v1/config').expect(200);
    const doc = await verified(res.body.jws);
    expect(doc).toEqual({
      schemaVersion: 1,
      release: 0,
      publishedAt: null,
      expiresAt: null,
      config: { minSupportedBuild: { ios: null, android: null }, features: { catalogBrowse: true, playlistImport: true, diagnosticsUpload: true }, catalogRefreshHours: 24 },
    });
    expect(res.headers.etag).toMatch(/^"r0-/);
    await http().get('/v1/config').set('If-None-Match', res.headers.etag).expect(304);
  });

  it('lets operators look but only admins change it; customers and editors get nothing', async () => {
    expect((await http().get('/v1/admin/config')).status).toBe(401);
    expect((await http().get('/v1/admin/config').set(await bearer('cfg-customer'))).status).toBe(403);
    expect((await http().get('/v1/admin/config').set(await bearer('cfg-editor'))).status).toBe(403);
    const ops = await http().get('/v1/admin/config').set(await bearer('cfg-ops')).expect(200);
    expect(ops.body.publishBlockers).toContain('admin_role_required');
    expect((await http().patch('/v1/admin/config/draft').set(await bearer('cfg-ops')).set('If-Match', '"0"').send({ catalogRefreshHours: 12 })).status).toBe(403);
  });

  it('refuses unknown or out-of-range fields instead of ignoring them', async () => {
    const a = await bearer('cfg-admin-a');
    const patch = (body: unknown) => http().patch('/v1/admin/config/draft').set(a).set('If-Match', '"0"').send(body as object);
    expect((await patch({ enableVideo: true })).body.details).toEqual({ field: 'enableVideo', reason: 'unknown_field' });
    expect((await patch({ features: { carplayVideo: true } })).body.details).toEqual({ field: 'features.carplayVideo', reason: 'unknown_field' });
    expect((await patch({ features: { catalogBrowse: 'no' } })).body.details).toMatchObject({ field: 'features.catalogBrowse' });
    expect((await patch({ minSupportedBuild: { ios: 0 } })).body.details).toMatchObject({ field: 'minSupportedBuild.ios' });
    expect((await patch({ catalogRefreshHours: 500 })).body.details).toMatchObject({ field: 'catalogRefreshHours' });
    expect((await http().patch('/v1/admin/config/draft').set(a).send({ catalogRefreshHours: 12 })).status).toBe(428);
  });

  it('drafts with compare-and-set, needs a second admin to publish, and signs the release for the apps', async () => {
    const a = await bearer('cfg-admin-a');
    const b = await bearer('cfg-admin-b');
    const edited = await http()
      .patch('/v1/admin/config/draft')
      .set(a)
      .set('If-Match', '"0"')
      .send({ minSupportedBuild: { ios: 42 }, features: { playlistImport: false } })
      .expect(200);
    expect(edited.headers.etag).toBe('"1"');
    expect(edited.body.draft.changedSinceRelease).toEqual(['minSupportedBuild.ios', 'features.playlistImport']);
    // A stale editor is told the current revision rather than overwriting.
    const stale = await http().patch('/v1/admin/config/draft').set(b).set('If-Match', '"0"').send({ catalogRefreshHours: 6 });
    expect(stale.status).toBe(412);
    expect(stale.body.details).toEqual({ currentRevision: 1 });

    // The author cannot publish their own change.
    const own = await http().post('/v1/admin/config/publish').set(a).set('If-Match', '"1"').send(reason);
    expect(own.status).toBe(409);
    expect(own.body.details.reasons).toEqual(['own_change']);
    // The reviewer must name the revision they saw.
    expect((await http().post('/v1/admin/config/publish').set(b).set('If-Match', '"0"').send(reason)).status).toBe(412);
    expect((await http().post('/v1/admin/config/publish').set(b).set('If-Match', '"1"').send({ reason: 'short' })).status).toBe(400);
    expect((await http().post('/v1/admin/config/publish').set(b).set('If-Match', '"1"').send({ ...reason, validDays: 365 })).status).toBe(400);

    const published = await http().post('/v1/admin/config/publish').set(b).set('If-Match', '"1"').send({ ...reason, validDays: 14 }).expect(200);
    expect(published.body.current).toMatchObject({ release: 1, draftRevision: 1, rollbackOf: null, publishedByYou: true, reason: reason.reason });
    expect(published.body.publishBlockers).toEqual(['no_changes']);
    const days = (Date.parse(published.body.current.expiresAt) - Date.parse(published.body.current.publishedAt)) / 86_400_000;
    expect(Math.round(days)).toBe(14);

    const res = await http().get('/v1/config').expect(200);
    expect(decodeProtectedHeader(res.body.jws).alg).toBe('EdDSA');
    const doc = await verified(res.body.jws);
    expect(doc).toMatchObject({ release: 1, config: { minSupportedBuild: { ios: 42, android: null }, features: { playlistImport: false, catalogBrowse: true } } });
    expect(res.headers.etag).toMatch(/^"r1-/);
    // A tampered payload does not verify.
    const [h, p, s] = res.body.jws.split('.');
    const forged = Buffer.from(JSON.stringify({ ...doc, config: { ...doc.config, features: { ...doc.config.features, playlistImport: true } } })).toString('base64url');
    await expect(verified(`${h}.${forged}.${s}`)).rejects.toThrow();
    expect(p).not.toBe(forged);

    const audit = await t.pool.query(`SELECT action, target_id, reason, changes FROM audit_events WHERE target_type = 'config' ORDER BY id`);
    expect(audit.rows.map((r) => r.action)).toEqual(['config.update', 'config.publish']);
    expect(audit.rows[0].changes).toMatchObject({ fields: ['minSupportedBuild.ios', 'features.playlistImport'], values: { 'minSupportedBuild.ios': 42, 'features.playlistImport': false } });
    expect(audit.rows[1]).toMatchObject({ target_id: '1', reason: reason.reason, changes: { draftRevision: 1, previousRelease: null, validDays: 14 } });
  });

  it('rolls back by re-releasing an earlier payload as a new release, and never edits history', async () => {
    const a = await bearer('cfg-admin-a');
    const b = await bearer('cfg-admin-b');
    // Release 2 turns import back on.
    await http().patch('/v1/admin/config/draft').set(b).set('If-Match', '"1"').send({ features: { playlistImport: true } }).expect(200);
    await http().post('/v1/admin/config/publish').set(a).set('If-Match', '"2"').send({ reason: 'import fixed in build 42, turn it back on' }).expect(200);
    expect((await verified((await http().get('/v1/config')).body.jws)).release).toBe(2);

    expect((await http().post('/v1/admin/config/releases/2/rollback').set(a).send(reason)).body.details.reasons).toEqual(['already_current']);
    expect((await http().post('/v1/admin/config/releases/99/rollback').set(a).send(reason)).status).toBe(404);
    expect((await http().post('/v1/admin/config/releases/abc/rollback').set(a).send(reason)).status).toBe(400);
    expect((await http().post('/v1/admin/config/releases/1/rollback').set(await bearer('cfg-ops')).send(reason)).status).toBe(403);

    // One admin may roll back alone, so a bad release can be undone quickly.
    const rolled = await http().post('/v1/admin/config/releases/1/rollback').set(b).send({ reason: 'import broke again, back to release 1' }).expect(200);
    expect(rolled.body.current).toMatchObject({ release: 3, rollbackOf: 1, draftRevision: null, config: { features: { playlistImport: false } } });
    expect(rolled.body.releases.map((r: { release: number }) => r.release)).toEqual([3, 2, 1]);
    expect(rolled.body.draft.revision).toBe(2);
    expect((await verified((await http().get('/v1/config')).body.jws)).release).toBe(3);

    await expect(t.pool.query('UPDATE app_config_releases SET reason = $1 WHERE release = 1', ['x'])).rejects.toThrow(/append-only/);
    await expect(t.pool.query('DELETE FROM app_config_releases WHERE release = 1')).rejects.toThrow(/append-only/);
    const { rows } = await t.pool.query(`SELECT action, changes FROM audit_events WHERE action = 'config.rollback'`);
    expect(rows).toEqual([{ action: 'config.rollback', changes: { rollbackOf: 1, previousRelease: 2, validDays: 30 } }]);
  });
});
