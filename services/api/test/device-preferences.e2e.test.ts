import request from 'supertest';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

describe('per-device setting overrides (Doc 17 PUT /me/devices/{id}/preferences)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());
  const bearer = async (sub: string, authTime?: number) => ({ Authorization: `Bearer ${await id.token(sub, authTime === undefined ? {} : { authTime })}` });
  const checkIn = async (sub: string, device: string) =>
    http().put(`/v1/me/devices/${device}`).set(await bearer(sub)).send({ platform: 'android', osMajor: 15, appBuild: '1.0.0+42' });

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('starts from the account, overrides allowlisted keys with a revision, and resets', async () => {
    const car = crypto.randomUUID();
    expect((await checkIn('dp-ann', car)).status).toBe(200);
    const ann = await bearer('dp-ann');
    await http().patch('/v1/me/settings').set(ann).set('If-Match', '"0"').send({ theme: 'light' }).expect(200);

    const start = await http().get(`/v1/me/devices/${car}/preferences`).set(ann).expect(200);
    expect(start.headers.etag).toBe('"0"');
    expect(start.body).toMatchObject({ revision: 0, overrides: {}, effective: { theme: 'light', language: 'th', cellularPolicy: 'allow' }, accountRevision: 1 });

    const put = (rev: number, overrides: unknown) => http().put(`/v1/me/devices/${car}/preferences`).set(ann).set('If-Match', `"${rev}"`).send({ overrides });
    const first = await put(0, { theme: 'dark', cellularPolicy: 'wifi_only' }).expect(200);
    expect(first.body).toMatchObject({ revision: 1, overrides: { theme: 'dark', cellularPolicy: 'wifi_only' }, effective: { theme: 'dark', language: 'th', cellularPolicy: 'wifi_only' } });
    expect((await put(0, { theme: 'light' })).status).toBe(412);
    expect((await put(1, { volume: 'loud' })).status).toBe(400);
    expect((await put(1, { theme: 'purple' })).status).toBe(400);
    expect((await http().put(`/v1/me/devices/${car}/preferences`).set(ann).send({ overrides: {} })).status).toBe(428);

    // The account changes; keys the device does not override follow it.
    await http().patch('/v1/me/settings').set(ann).set('If-Match', '"1"').send({ language: 'en', theme: 'system' }).expect(200);
    expect((await http().get(`/v1/me/devices/${car}/preferences`).set(ann).expect(200)).body.effective).toEqual({ theme: 'dark', language: 'en', cellularPolicy: 'wifi_only' });

    const list = await http().get('/v1/me/devices').set(ann).expect(200);
    expect(list.body.serverObservedAt).toEqual(expect.any(String));
    expect(list.body.devices[0]).toMatchObject({ id: car, overrides: { theme: 'dark', cellularPolicy: 'wifi_only' }, preferencesRevision: 1 });

    const reset = await put(1, {}).expect(200);
    expect(reset.body).toMatchObject({ revision: 2, overrides: {}, effective: { theme: 'system', language: 'en', cellularPolicy: 'allow' } });
  });

  it('is the owner’s only, and not for signed-out devices', async () => {
    const phone = crypto.randomUUID();
    expect((await checkIn('dp-ben', phone)).status).toBe(200);
    const other = await bearer('dp-cat');
    await http().get(`/v1/me/devices/${phone}/preferences`).set(other).expect(404);
    await http().put(`/v1/me/devices/${phone}/preferences`).set(other).set('If-Match', '"0"').send({ overrides: { theme: 'dark' } }).expect(404);
    await http().get('/v1/me/devices/not-a-uuid/preferences').set(other).expect(400);

    await http().delete(`/v1/me/devices/${phone}/session`).set(await bearer('dp-ben', Math.floor(Date.now() / 1000))).expect(200);
    expect((await http().get(`/v1/me/devices/${phone}/preferences`).set(await bearer('dp-ben'))).body.code).toBe('DEVICE_REVOKED');
  });
});
