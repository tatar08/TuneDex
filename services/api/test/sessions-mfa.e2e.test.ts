import request from 'supertest';
import { DevicesService } from '../src/devices/devices.service';
import { Database } from '../src/db/database';
import { runStaffCli } from '../src/staff/staff-cli';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

const PHONE = '3d1f0a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b';
const OTHER = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const report = { platform: 'android', osMajor: 15, appBuild: '1.0.0+42', appliedSettingsRevision: 0 };

describe('device sign-out ends the Keycloak session, and privileged staff actions need recent MFA', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());
  const now = () => Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver, { config: { staffMfaAcr: ['2'] } });
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('records the phone\'s Keycloak session, ends it on sign-out, and refuses that session afterwards', async () => {
    const phone = await id.token('sess-owner', { sid: 'kc-session-phone' });
    const web = await id.token('sess-owner', { sid: 'kc-session-web', authTime: now() });
    await http().put(`/v1/me/devices/${PHONE}`).set('Authorization', `Bearer ${phone}`).send(report).expect(200);
    await http().put(`/v1/me/devices/${OTHER}`).set('Authorization', `Bearer ${await id.token('sess-owner', { sid: 'kc-session-tablet' })}`).send(report).expect(200);

    await http().delete(`/v1/me/devices/${PHONE}/session`).set('Authorization', `Bearer ${web}`).expect(200);
    expect(t.idp.endedSessions).toEqual(['kc-session-phone', 'kc-session-phone:offline']);
    // Any token from that session is refused, including one the phone refreshes later.
    const refreshed = await id.token('sess-owner', { sid: 'kc-session-phone' });
    const res = await http().get('/v1/me/settings').set('Authorization', `Bearer ${refreshed}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DEVICE_REVOKED');
    // The web session and the other phone keep working.
    await http().get('/v1/me/settings').set('Authorization', `Bearer ${web}`).expect(200);
    await http().get('/v1/me/settings').set('Authorization', `Bearer ${await id.token('sess-owner', { sid: 'kc-session-tablet' })}`).expect(200);
    // Another account using the same session id string is unaffected.
    await http().get('/v1/me/settings').set('Authorization', `Bearer ${await id.token('sess-stranger', { sid: 'kc-session-phone' })}`).expect(200);
  });

  it('retries the Keycloak call when it fails, without undoing the sign-out', async () => {
    const web = await id.token('sess-retry', { sid: 'kc-web-2', authTime: now() });
    await http().put(`/v1/me/devices/${PHONE}`).set('Authorization', `Bearer ${await id.token('sess-retry', { sid: 'kc-phone-2' })}`).send(report).expect(200);
    t.idp.state.failSessions = true;
    try {
      const res = await http().delete(`/v1/me/devices/${PHONE}/session`).set('Authorization', `Bearer ${web}`).expect(200);
      expect(res.body.revokedAt).not.toBeNull();
      expect(t.logs.lines().some((l) => l.eventCode === 'IDP_SESSION_END_FAILED')).toBe(true);
      expect((await http().get('/v1/me/settings').set('Authorization', `Bearer ${await id.token('sess-retry', { sid: 'kc-phone-2' })}`)).status).toBe(403);
    } finally {
      t.idp.state.failSessions = false;
    }
    // The retry waits for the first backoff step (1 minute), then runs.
    const { rows: [row] } = await t.pool.query(`SELECT idp_session_attempts, idp_session_error_code FROM devices WHERE id = $1 AND idp_session_id = 'kc-phone-2'`, [PHONE]);
    expect(row).toEqual({ idp_session_attempts: 1, idp_session_error_code: 'IDP_SESSION_FAILED' });
    expect(await t.app.get(DevicesService).retrySessionEnds()).toBe(0);
    await t.pool.query(`UPDATE devices SET idp_session_next_attempt_at = now() WHERE idp_session_id = 'kc-phone-2'`);
    expect(await t.app.get(DevicesService).retrySessionEnds()).toBe(1);
    expect(t.idp.endedSessions).toContain('kc-phone-2');
    expect(await t.app.get(DevicesService).retrySessionEnds()).toBe(0);
  });

  it('replaces an admin token Keycloak stopped accepting and ends the session in the same request', async () => {
    const web = await id.token('sess-rotate', { sid: 'kc-web-3', authTime: now() });
    await http().put(`/v1/me/devices/${PHONE}`).set('Authorization', `Bearer ${await id.token('sess-rotate', { sid: 'kc-phone-3' })}`).send(report).expect(200);
    t.idp.state.validToken = 'admin-token-rotated';
    const before = t.idp.state.tokenRequests;
    await http().delete(`/v1/me/devices/${PHONE}/session`).set('Authorization', `Bearer ${web}`).expect(200);
    expect(t.idp.endedSessions).toContain('kc-phone-3');
    expect(t.idp.state.tokenRequests).toBe(before + 1);
  });

  it('asks for MFA from the last 5 minutes before publishing, rolling back or exporting audit', async () => {
    const staff = (...args: string[]) => runStaffCli(args, new Database(t.pool), () => undefined);
    for (const sub of ['mfa-admin', 'mfa-auditor']) await http().get('/v1/me/settings').set('Authorization', `Bearer ${await id.token(sub)}`).expect(200);
    expect(await staff('grant', 'mfa-admin', 'admin', '--by', 'tar', '--reason', 'mfa tests')).toBe(0);
    expect(await staff('grant', 'mfa-auditor', 'auditor', '--by', 'tar', '--reason', 'mfa tests')).toBe(0);
    const reason = { reason: 'checking the MFA requirement on publish' };
    const publish = async (o: { authTime?: number; acr?: string }) =>
      http().post('/v1/admin/config/publish').set('Authorization', `Bearer ${await id.token('mfa-admin', o)}`).set('If-Match', '"0"').send(reason);

    const plain = await publish({ authTime: now(), acr: '1' });
    expect(plain.status).toBe(401);
    // A password-only session is stopped at the door; an MFA session from 10 minutes ago needs a fresh code to publish.
    expect(plain.body).toMatchObject({ code: 'MFA_REQUIRED', details: { scope: 'session' } });
    expect((await publish({ authTime: now() - 600, acr: '2' })).body).toMatchObject({ code: 'MFA_REQUIRED', details: { maxAgeSeconds: 300 } });
    // With fresh MFA the request reaches the normal publish rules (here: nothing to publish).
    const fresh = await publish({ authTime: now(), acr: '2' });
    expect(fresh.status).toBe(409);
    expect(fresh.body.details.reasons).toEqual(['no_changes']);

    expect((await http().post('/v1/admin/config/releases/1/rollback').set('Authorization', `Bearer ${await id.token('mfa-admin', { authTime: now() })}`).send(reason)).body.code).toBe('MFA_REQUIRED');
    const exp = (o: { authTime?: number; acr?: string }) => async () =>
      http().post('/v1/admin/audit/export').set('Authorization', `Bearer ${await id.token('mfa-auditor', o)}`).send({ reason: 'quarterly review of changes' });
    expect((await (await exp({ authTime: now() }))()).body.code).toBe('MFA_REQUIRED');
    expect((await (await exp({ authTime: now(), acr: '2' }))()).status).toBe(200);
    // Reading needs a session that signed in with MFA, but not a fresh one.
    const read = await http().get('/v1/admin/config').set('Authorization', `Bearer ${await id.token('mfa-admin')}`);
    expect(read.status).toBe(401);
    expect(read.body).toMatchObject({ code: 'MFA_REQUIRED', details: { scope: 'session' } });
    await http().get('/v1/admin/config').set('Authorization', `Bearer ${await id.token('mfa-admin', { authTime: now() - 3600, acr: '2' })}`).expect(200);
  });

  it('lets staff in only with an MFA sign-in, which lasts for the Keycloak session after the token drops to password level', async () => {
    const staff = (...args: string[]) => runStaffCli(args, new Database(t.pool), () => undefined);
    await http().get('/v1/me/settings').set('Authorization', `Bearer ${await id.token('mfa-ops')}`).expect(200);
    expect(await staff('grant', 'mfa-ops', 'operator', '--by', 'tar', '--reason', 'mfa tests')).toBe(0);
    const as = async (o: { sid?: string; authTime?: number; acr?: string }) => ({ Authorization: `Bearer ${await id.token('mfa-ops', o)}` });

    // Signed in with a password only: roles are visible, staff pages are not.
    const me = await http().get('/v1/me/staff').set(await as({ sid: 'kc-ops-1', authTime: now(), acr: '1' })).expect(200);
    expect(me.body).toMatchObject({ roles: ['operator'], mfa: false });
    expect((await http().get('/v1/admin/jobs').set(await as({ sid: 'kc-ops-1', authTime: now(), acr: '1' }))).body.code).toBe('MFA_REQUIRED');

    // An MFA sign-in in that session; later refreshed tokens say `acr` 1 but the session still counts.
    expect((await http().get('/v1/me/staff').set(await as({ sid: 'kc-ops-1', authTime: now(), acr: '2' })).expect(200)).body.mfa).toBe(true);
    await http().get('/v1/admin/jobs').set(await as({ sid: 'kc-ops-1', authTime: now() - 600, acr: '1' })).expect(200);
    // Another Keycloak session of the same person does not.
    expect((await http().get('/v1/admin/jobs').set(await as({ sid: 'kc-ops-2', acr: '1' }))).status).toBe(401);
    // After 12 hours the session no longer counts.
    await t.pool.query(`UPDATE staff_mfa_sessions SET mfa_at = now() - interval '13 hours'`);
    expect((await http().get('/v1/admin/jobs').set(await as({ sid: 'kc-ops-1', acr: '1' }))).status).toBe(401);
  });

  it('reports a new roles version whenever a role is granted or revoked', async () => {
    const staff = (...args: string[]) => runStaffCli(args, new Database(t.pool), () => undefined);
    const me = async () => (await http().get('/v1/me/staff').set('Authorization', `Bearer ${await id.token('mfa-version')}`).expect(200)).body;
    const none = (await me()).rolesVersion;
    expect(await staff('grant', 'mfa-version', 'support', '--by', 'tar', '--reason', 'v')).toBe(0);
    const granted = (await me()).rolesVersion;
    expect(granted).not.toBe(none);
    expect((await me()).rolesVersion).toBe(granted);
    expect(await staff('revoke', 'mfa-version', 'support', '--by', 'tar', '--reason', 'v')).toBe(0);
    expect((await me()).rolesVersion).not.toBe(granted);
  });
});
