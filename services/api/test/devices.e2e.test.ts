import request from 'supertest';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

const D1 = '0b9a4f8e-6c1d-4e2a-9f3b-1a2b3c4d5e6f';
const D2 = '7c2e9d10-3b4a-4f5e-8a6b-9c0d1e2f3a4b';
const report = { platform: 'ios', osMajor: 18, appBuild: '1.0.0+42', appliedSettingsRevision: 0 };

describe('/v1/me/devices', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());
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

  const put = (token: string, deviceId: string, body: unknown) =>
    http().put(`/v1/me/devices/${deviceId}`).set('Authorization', `Bearer ${token}`).send(body as object);
  const list = (token: string) => http().get('/v1/me/devices').set('Authorization', `Bearer ${token}`);

  it('requires sign-in', async () => {
    expect((await http().get('/v1/me/devices')).status).toBe(401);
    expect((await http().put(`/v1/me/devices/${D1}`).send(report)).status).toBe(401);
  });

  it('registers a device, then records check-ins with the applied settings revision', async () => {
    const token = await id.token('dev-owner');
    const first = await put(token, D1, report);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ id: D1, platform: 'ios', osMajor: 18, appBuild: '1.0.0+42', appliedSettingsRevision: 0, revokedAt: null });

    await http().patch('/v1/me/settings').set('Authorization', `Bearer ${token}`).set('If-Match', '"0"').send({ theme: 'dark' }).expect(200);
    const listed = await list(token);
    expect(listed.body.settingsRevision).toBe(1);
    expect(listed.body.devices[0].appliedSettingsRevision).toBe(0);

    const applied = await put(token, D1, { ...report, appBuild: '1.0.1+43', appliedSettingsRevision: 1 });
    expect(applied.body).toMatchObject({ appliedSettingsRevision: 1, appBuild: '1.0.1+43' });
    expect(new Date(applied.body.lastSeenAt).getTime()).toBeGreaterThanOrEqual(new Date(first.body.lastSeenAt).getTime());
  });

  it('never moves the applied revision backwards when an old report arrives late', async () => {
    const token = await id.token('dev-late');
    await http().patch('/v1/me/settings').set('Authorization', `Bearer ${token}`).set('If-Match', '"0"').send({ theme: 'dark' });
    await put(token, D1, { ...report, appliedSettingsRevision: 1 }).expect(200);
    const late = await put(token, D1, { ...report, appliedSettingsRevision: 0 });
    expect(late.body.appliedSettingsRevision).toBe(1);
  });

  it('rejects an applied revision the server never issued', async () => {
    const token = await id.token('dev-ahead');
    const res = await put(token, D1, { ...report, appliedSettingsRevision: 3 });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual({ field: 'appliedSettingsRevision', reason: 'ahead_of_server', settingsRevision: 0 });
  });

  it.each([
    ['unknown field', { ...report, email: 'a@b.c' }, 'email'],
    ['bad platform', { ...report, platform: 'windows' }, 'platform'],
    ['bad os version', { ...report, osMajor: 100 }, 'osMajor'],
    ['bad build string', { ...report, appBuild: '1.0 <script>' }, 'appBuild'],
    ['negative revision', { ...report, appliedSettingsRevision: -1 }, 'appliedSettingsRevision'],
  ])('rejects a report with %s', async (_label, body, field) => {
    const token = await id.token('dev-validation');
    const res = await put(token, D1, body);
    expect(res.status).toBe(400);
    expect(res.body.details.field).toBe(field);
  });

  it('rejects a device id that is not a UUID', async () => {
    const token = await id.token('dev-validation');
    expect((await put(token, 'not-a-uuid', report)).status).toBe(400);
  });

  it('keeps accounts apart even when two accounts use the same device id', async () => {
    const a = await id.token('dev-iso-a');
    const b = await id.token('dev-iso-b');
    await put(a, D2, report).expect(200);
    expect((await list(b)).body.devices).toEqual([]);
    await put(b, D2, { ...report, platform: 'android' }).expect(200);
    expect((await list(a)).body.devices[0].platform).toBe('ios');
    // B cannot revoke A's device: it only ever sees and revokes its own.
    const fresh = await id.token('dev-iso-b', { authTime: now() });
    await http().delete(`/v1/me/devices/${D2}/session`).set('Authorization', `Bearer ${fresh}`).expect(200);
    expect((await list(a)).body.devices[0].revokedAt).toBeNull();
  });

  describe('revoke', () => {
    it('requires a sign-in within the last 5 minutes', async () => {
      const stale = await id.token('dev-revoke', { authTime: now() - 301 });
      await put(stale, D1, report).expect(200);
      const res = await http().delete(`/v1/me/devices/${D1}/session`).set('Authorization', `Bearer ${stale}`);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'REAUTH_REQUIRED', details: { maxAgeSeconds: 300 } });

      const none = await id.token('dev-revoke');
      expect((await http().delete(`/v1/me/devices/${D1}/session`).set('Authorization', `Bearer ${none}`)).status).toBe(401);
    });

    it('revokes the device, after which it cannot check in again', async () => {
      const fresh = await id.token('dev-revoke', { authTime: now() - 10 });
      const res = await http().delete(`/v1/me/devices/${D1}/session`).set('Authorization', `Bearer ${fresh}`);
      expect(res.status).toBe(200);
      expect(res.body.revokedAt).not.toBeNull();
      const again = await put(fresh, D1, report);
      expect(again.status).toBe(403);
      expect(again.body.code).toBe('DEVICE_REVOKED');
      expect((await list(fresh)).body.devices[0].revokedAt).not.toBeNull();
      // Audited once, as the owner; a repeat revoke keeps the original time and adds no second record.
      await http().delete(`/v1/me/devices/${D1}/session`).set('Authorization', `Bearer ${fresh}`).expect(200);
      const audit = await t.pool.query(`SELECT actor, changes FROM audit_events WHERE action = 'device.revoke' AND target_id = $1`, [D1]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].changes).toEqual({ platform: 'ios' });
    });

    it('returns 404 for a device the account does not have', async () => {
      const fresh = await id.token('dev-revoke', { authTime: now() });
      expect((await http().delete(`/v1/me/devices/${D2}/session`).set('Authorization', `Bearer ${fresh}`)).status).toBe(404);
    });
  });

  it('caps active devices per account at 20', async () => {
    const token = await id.token('dev-many');
    const ids = Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    for (const d of ids.slice(0, 20)) await put(token, d, report).expect(200);
    const res = await put(token, ids[20], report);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'DEVICE_LIMIT', details: { maxActiveDevices: 20 } });
    // A known device can still check in at the cap.
    await put(token, ids[0], report).expect(200);
  });

  it('holds the cap when many new devices check in at once', async () => {
    const token = await id.token('dev-burst');
    const ids = Array.from({ length: 25 }, (_, i) => `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`);
    const results = await Promise.all(ids.map((d) => put(token, d, report)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(20);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect((await list(token)).body.devices).toHaveLength(20);
  });
});
