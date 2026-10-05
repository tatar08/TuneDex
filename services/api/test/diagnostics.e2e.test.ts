import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

const event = (over: Record<string, unknown> = {}) => ({
  eventId: randomUUID(),
  eventName: 'playback_stall',
  schemaVersion: 1,
  monotonicMs: 120_000,
  sessionRandomId: 'sess_ab12cd34',
  durationMs: 3200,
  resultCode: 'MEDIA_STALLED',
  networkClass: 'cellular',
  appBuild: '1.0.0+42',
  osMajor: 18,
  deviceClass: 'phone',
  ...over,
});

describe('client diagnostics', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let alice: Record<string, string>;
  let bob: Record<string, string>;
  const device = randomUUID();
  const http = () => request(t.app.getHttpServer());
  const upload = (who: Record<string, string>, body: object) => http().post('/v1/diagnostics/batches').set(who).send(body);
  const batch = (over: Record<string, unknown> = {}) => ({ batchId: randomUUID(), deviceId: device, consent: true, events: [event()], ...over });

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
    alice = { Authorization: `Bearer ${await id.token('diag-alice')}` };
    bob = { Authorization: `Bearer ${await id.token('diag-bob')}` };
    await http().put(`/v1/me/devices/${device}`).set(alice).send({ platform: 'ios', osMajor: 18, appBuild: '1.0.0+42' }).expect(200);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('stores an opted-in batch and shows the owner exactly what was sent', async () => {
    const b = batch({ events: [event(), event({ eventName: 'playback_recovered', resultCode: null, durationMs: undefined })] });
    const res = await upload(alice, b).expect(200);
    expect(res.body).toEqual({ reportId: expect.any(String), accepted: 2, duplicates: 0 });

    const list = (await http().get('/v1/me/diagnostics').set(alice).expect(200)).body;
    expect(list.retentionDays).toBe(7);
    expect(list.reports[0]).toMatchObject({ id: res.body.reportId, deviceId: device, platform: 'ios', eventCount: 2 });
    expect(list.reports[0].events).toEqual(expect.arrayContaining([{ eventName: 'playback_stall', count: 1 }, { eventName: 'playback_recovered', count: 1 }]));
    const detail = (await http().get(`/v1/me/diagnostics/${res.body.reportId}`).set(alice).expect(200)).body;
    expect(detail.items).toHaveLength(2);
    expect(detail.items.find((e: { eventId: string }) => e.eventId === b.events[0].eventId)).toEqual(b.events[0]);
  });

  it('is safe to retry: the same batch or the same events are not stored twice', async () => {
    const b = batch();
    const first = (await upload(alice, b).expect(200)).body;
    expect((await upload(alice, b).expect(200)).body).toEqual({ reportId: first.reportId, accepted: 0, duplicates: 1 });
    const again = (await upload(alice, batch({ events: [b.events[0], event()] })).expect(200)).body;
    expect(again).toMatchObject({ accepted: 1, duplicates: 1 });
  });

  it('refuses anything outside the schema, so no URL or title can ride along', async () => {
    const cases: [object, string, string][] = [
      [batch({ consent: false }), 'consent', 'consent_required'],
      [batch({ consent: undefined }), 'consent', 'consent_required'],
      [batch({ events: [event({ streamUrl: 'https://secret.example/token=abc' })] }), 'events[0].streamUrl', 'unknown_field'],
      [batch({ events: [event({ resultCode: 'could not open https://x' })] }), 'events[0].resultCode', 'malformed'],
      [batch({ events: [event({ eventName: 'search_query' })] }), 'events[0].eventName', 'value_not_allowed'],
      [batch({ events: [event({ schemaVersion: 2 })] }), 'events[0].schemaVersion', 'unsupported'],
      [batch({ events: [event({ sessionRandomId: 'my name is alice' })] }), 'events[0].sessionRandomId', 'malformed'],
      [batch({ events: [] }), 'events', 'must_be_non_empty_array'],
      [batch({ events: Array.from({ length: 101 }, () => event()) }), 'events', 'too_many'],
      [batch({ location: 'BKK' }), 'location', 'unknown_field'],
    ];
    for (const [body, field, reason] of cases) {
      const res = await upload(alice, body);
      expect([res.status, res.body.details]).toEqual([400, { field, reason }]);
    }
    const dupe = event();
    expect((await upload(alice, batch({ events: [dupe, dupe] }))).body.details.reason).toBe('duplicate_event_id');
  });

  it('accepts a full 100-event batch over the normal 16 KiB body limit, but not over 128 KiB', async () => {
    const big = batch({ events: Array.from({ length: 100 }, () => event()) });
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(16 * 1024);
    expect((await upload(alice, big).expect(200)).body.accepted).toBe(100);
    const huge = { ...batch(), padding: 'x'.repeat(130 * 1024) };
    expect((await upload(alice, huge)).status).toBe(413);
    // Other routes keep the small limit.
    expect((await http().patch('/v1/me/settings').set(alice).set('If-Match', '"0"').send({ theme: 'x'.repeat(20 * 1024) })).status).toBe(413);
  });

  it('only takes batches from the owner’s own, active devices', async () => {
    expect((await upload(bob, batch())).status).toBe(404);
    expect((await upload(alice, batch({ deviceId: randomUUID() }))).body.details).toEqual({ field: 'deviceId', reason: 'device_not_registered' });
    const old = randomUUID();
    await http().put(`/v1/me/devices/${old}`).set(alice).send({ platform: 'android', osMajor: 15, appBuild: '1.0.0' }).expect(200);
    await t.pool.query('UPDATE devices SET revoked_at = now() WHERE id = $1', [old]);
    expect((await upload(alice, batch({ deviceId: old }))).body.code).toBe('DEVICE_REVOKED');
    expect((await http().post('/v1/diagnostics/batches').send(batch())).status).toBe(401);
  });

  it('allows at most 10 batches a minute per device', async () => {
    const dev = randomUUID();
    await http().put(`/v1/me/devices/${dev}`).set(alice).send({ platform: 'ios', osMajor: 18, appBuild: '1.0.0' }).expect(200);
    for (let i = 0; i < 10; i++) await upload(alice, batch({ deviceId: dev })).expect(200);
    const over = await upload(alice, batch({ deviceId: dev }));
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBe('60');
    expect(over.body).toMatchObject({ code: 'API_RATE_LIMITED', details: { scope: 'device_batches' } });
  });

  it('lets only the owner see or delete a report, and deletes its events', async () => {
    const { reportId } = (await upload(alice, batch()).expect(200)).body;
    expect((await http().get(`/v1/me/diagnostics/${reportId}`).set(bob)).status).toBe(404);
    expect((await http().delete(`/v1/me/diagnostics/${reportId}`).set(bob)).status).toBe(404);
    expect((await http().get('/v1/me/diagnostics').set(bob).expect(200)).body.reports).toEqual([]);
    await http().delete(`/v1/me/diagnostics/${reportId}`).set(alice).expect(204);
    expect((await http().get(`/v1/me/diagnostics/${reportId}`).set(alice)).status).toBe(404);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM diagnostic_events WHERE report_id = $1', [reportId])).rows[0].n).toBe(0);
    expect((await http().delete('/v1/me/diagnostics/not-a-uuid').set(alice)).status).toBe(400);
  });

  it('drops reports after 7 days', async () => {
    const { reportId } = (await upload(alice, batch()).expect(200)).body;
    await t.pool.query(`UPDATE diagnostic_reports SET received_at = now() - interval '8 days' WHERE id = $1`, [reportId]);
    const { DiagnosticsService } = await import('../src/diagnostics/diagnostics');
    expect(await t.app.get(DiagnosticsService).prune()).toBeGreaterThanOrEqual(1);
    expect((await t.pool.query('SELECT 1 FROM diagnostic_reports WHERE id = $1', [reportId])).rowCount).toBe(0);
  });

  it('never writes event contents to the logs', async () => {
    t.logs.mark();
    await upload(alice, batch({ events: [event({ resultCode: 'CANARY_CODE_XYZ', sessionRandomId: 'canary_session_123' })] })).expect(200);
    expect(t.logs.raw()).not.toMatch(/CANARY_CODE_XYZ|canary_session_123/);
  });

  it('answers 400, not 500, for a well-formed cursor with a bogus key', async () => {
    const bogus = Buffer.from(JSON.stringify(['not-a-time', 'x'])).toString('base64url');
    const res = await http().get(`/v1/me/diagnostics?cursor=${bogus}`).set(alice);
    expect(res.status).toBe(400);
    expect(res.body.details).toMatchObject({ field: 'cursor' });
  });
});
