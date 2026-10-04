import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuditRetentionService } from '../src/audit/audit-retention';
import { SyncService } from '../src/sync/sync';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

describe('account sync (/v1/sync) and audit retention', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());
  const bearer = async (sub: string) => ({ Authorization: `Bearer ${await id.token(sub)}` });
  let jazz: string;
  let news: string;
  let hidden: string;
  const phone = randomUUID();

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
    await http().get('/v1/me/settings').set(await bearer('sync-a')).expect(200);
    await http().get('/v1/me/settings').set(await bearer('sync-b')).expect(200);
    const [{ id: author }] = (await t.pool.query(`SELECT id FROM users LIMIT 1`)).rows;
    const station = async (name: string, published: boolean) => {
      const draft = { name, country: 'TH', language: 'th', genres: ['jazz'], streamUrl: 'https://radio.test/s', codec: 'mp3', bitrateKbps: 128 };
      const { rows } = await t.pool.query(
        `INSERT INTO radio_stations (draft, created_by, updated_by, published, published_revision, published_by, published_at)
         VALUES ($1, $2, $2, $3, $4, $5, $6) RETURNING id`,
        [draft, author, published ? draft : null, published ? 1 : null, published ? author : null, published ? new Date() : null],
      );
      return rows[0].id as string;
    };
    jazz = await station('Jazz FM', true);
    news = await station('News 24', true);
    hidden = await station('Draft only', false);
    await http().put(`/v1/me/devices/${phone}`).set(await bearer('sync-a')).send({ platform: 'ios', osMajor: 18, appBuild: '42', appliedSettingsRevision: 0 }).expect(200);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  const fav = (entityId: string, stationId: string, order: number, baseRevision = 0, op = 'upsert') => ({ changeId: randomUUID(), entityId, type: 'favorite', op, baseRevision, value: { stationId, order } });

  it('refuses malformed pushes with the field path, before applying anything', async () => {
    const a = await bearer('sync-a');
    const push = (body: unknown) => http().post('/v1/sync/push').set(a).send(body as object);
    expect((await push({ changes: [] })).body.details).toEqual({ field: 'changes', reason: 'must_be_non_empty_array' });
    expect((await push({ changes: [{ ...fav(randomUUID(), jazz, 0), extra: 1 }] })).body.details).toEqual({ field: 'changes[0].extra', reason: 'unknown_field' });
    expect((await push({ changes: [{ ...fav(randomUUID(), jazz, 0), type: 'source' }] })).body.details).toEqual({ field: 'changes[0].type', reason: 'unsupported' });
    expect((await push({ changes: [fav(randomUUID(), jazz, -1)] })).body.details).toEqual({ field: 'changes[0].value.order', reason: 'out_of_range' });
    expect((await push({ changes: [{ ...fav(randomUUID(), jazz, 0), value: { stationId: jazz, order: 0, url: 'x' } }] })).body.details).toEqual({ field: 'changes[0].value.url', reason: 'unknown_field' });
    const c = fav(randomUUID(), jazz, 0);
    expect((await push({ changes: [c, { ...c }] })).body.details).toEqual({ field: 'changes[1].changeId', reason: 'duplicate_in_request' });
    expect((await push({ changes: Array.from({ length: 101 }, () => fav(randomUUID(), jazz, 0)) })).body.details).toEqual({ field: 'changes', reason: 'too_many' });
    expect((await http().post('/v1/sync/push').send({ changes: [fav(randomUUID(), jazz, 0)] })).status).toBe(401);
    expect((await http().get('/v1/sync/pull').set(a)).body.changes).toEqual([]);
  });

  it('applies creates, replays a changeId with the same result, and refuses a reused changeId with a different body', async () => {
    const a = await bearer('sync-a');
    const e1 = randomUUID();
    const create = fav(e1, jazz, 0);
    const first = await http().post('/v1/sync/push').set(a).send({ deviceId: phone, changes: [create, fav(randomUUID(), hidden, 1)] }).expect(200);
    expect(first.body.results).toEqual([
      { changeId: create.changeId, entityId: e1, status: 'applied', revision: 1 },
      expect.objectContaining({ status: 'rejected', reason: 'unknown_station' }),
    ]);
    const replay = await http().post('/v1/sync/push').set(a).send({ changes: [create] }).expect(200);
    expect(replay.body.results[0]).toEqual(first.body.results[0]);
    const reused = await http().post('/v1/sync/push').set(a).send({ changes: [{ ...create, value: { stationId: jazz, order: 5 } }] }).expect(200);
    expect(reused.body.results[0]).toMatchObject({ status: 'rejected', reason: 'change_id_reused' });

    // The device's last sync shows on its record.
    const devices = await http().get('/v1/me/devices').set(a).expect(200);
    expect(devices.body.devices[0].lastSyncedAt).not.toBeNull();
  });

  it('applies an update only on the current revision, and lets a delete win over stale updates', async () => {
    const a = await bearer('sync-a');
    const e = randomUUID();
    await http().post('/v1/sync/push').set(a).send({ changes: [fav(e, news, 1)] }).expect(200);
    const results = (await http().post('/v1/sync/push').set(a).send({ changes: [fav(e, news, 2, 1), fav(e, news, 3, 1)] }).expect(200)).body.results;
    expect(results[0]).toMatchObject({ status: 'applied', revision: 2 });
    expect(results[1]).toMatchObject({ status: 'conflict', reason: 'revision_mismatch', current: { revision: 2, value: { stationId: news, order: 2 }, deleted: false } });

    const del = { changeId: randomUUID(), entityId: e, type: 'favorite', op: 'delete', baseRevision: 2 };
    expect((await http().post('/v1/sync/push').set(a).send({ changes: [del] })).body.results[0]).toMatchObject({ status: 'applied', revision: 3 });
    // A phone that was offline still holds revision 2 and its edit loses to the delete.
    expect((await http().post('/v1/sync/push').set(a).send({ changes: [fav(e, news, 9, 2)] })).body.results[0]).toMatchObject({ status: 'conflict', reason: 'revision_mismatch', current: { revision: 3, value: null, deleted: true } });
    expect((await http().post('/v1/sync/push').set(a).send({ changes: [fav(e, news, 9, 3)] })).body.results[0]).toMatchObject({ status: 'conflict', reason: 'deleted' });
    // A create cannot revive the deleted id; a restore naming the tombstone revision can.
    expect((await http().post('/v1/sync/push').set(a).send({ changes: [fav(e, news, 0)] })).body.results[0]).toMatchObject({ status: 'conflict', reason: 'exists' });
    expect((await http().post('/v1/sync/push').set(a).send({ changes: [fav(e, news, 4, 3, 'restore')] })).body.results[0]).toMatchObject({ status: 'applied', revision: 4 });
    expect((await http().post('/v1/sync/push').set(a).send({ changes: [fav(e, news, 4, 4, 'restore')] })).body.results[0]).toMatchObject({ status: 'conflict', reason: 'not_deleted' });
    expect((await http().post('/v1/sync/push').set(a).send({ changes: [fav(randomUUID(), news, 0, 7)] })).body.results[0]).toMatchObject({ status: 'conflict', reason: 'not_found', current: null });
  });

  it('keeps one favorite per station and never shows one account another account\'s entities', async () => {
    const a = await bearer('sync-a');
    const b = await bearer('sync-b');
    const dup = (await http().post('/v1/sync/push').set(a).send({ changes: [fav(randomUUID(), jazz, 7)] })).body.results[0];
    expect(dup).toMatchObject({ status: 'conflict', reason: 'station_already_favorite' });
    expect(dup.existingEntityId).toMatch(/^[0-9a-f-]{36}$/);
    // B may favorite the same station, and sees only its own entity; B cannot touch A's entity ids.
    expect((await http().post('/v1/sync/push').set(b).send({ changes: [fav(randomUUID(), jazz, 0)] })).body.results[0]).toMatchObject({ status: 'applied' });
    expect((await http().post('/v1/sync/push').set(b).send({ changes: [fav(dup.existingEntityId, jazz, 0, 1)] })).body.results[0]).toMatchObject({ status: 'conflict', reason: 'not_found', current: null });
    expect((await http().get('/v1/sync/pull').set(b)).body.changes).toHaveLength(1);
    // B's device id is not B's to use.
    expect((await http().get(`/v1/sync/pull?deviceId=${phone}`).set(b)).status).toBe(404);
  });

  it('pulls in pages after a cursor, and sends a device behind the purged horizon back to a full reconcile', async () => {
    const a = await bearer('sync-a');
    const all = (await http().get('/v1/sync/pull').set(a).expect(200)).body;
    expect(all.changes.map((c: { value: { stationId: string } | null }) => c.value?.stationId).sort()).toEqual([jazz, news].sort());
    expect(all.hasMore).toBe(false);
    const p1 = (await http().get('/v1/sync/pull?limit=1').set(a)).body;
    expect(p1).toMatchObject({ hasMore: true });
    const p2 = (await http().get(`/v1/sync/pull?limit=1&cursor=${p1.cursor}`).set(a)).body;
    expect(p2.changes[0].entityId).not.toBe(p1.changes[0].entityId);
    const empty = (await http().get(`/v1/sync/pull?cursor=${all.cursor}`).set(a)).body;
    expect(empty).toEqual({ changes: [], cursor: all.cursor, hasMore: false });
    expect((await http().get('/v1/sync/pull?cursor=bogus!').set(a)).status).toBe(400);

    // A tombstone older than 90 days is purged; a cursor from before it gets 410, a full pull still works.
    const [{ entity_id: oldId }] = (await t.pool.query(`SELECT entity_id FROM synced_entities WHERE value->>'stationId' = $1 AND user_id = (SELECT user_id FROM devices WHERE id = $2)`, [news, phone])).rows;
    const rev = (await t.pool.query(`SELECT revision FROM synced_entities WHERE entity_id = $1`, [oldId])).rows[0].revision;
    await http().post('/v1/sync/push').set(a).send({ changes: [{ changeId: randomUUID(), entityId: oldId, type: 'favorite', op: 'delete', baseRevision: Number(rev) }] });
    await t.pool.query(`UPDATE synced_entities SET deleted_at = now() - interval '91 days' WHERE entity_id = $1`, [oldId]);
    expect((await t.app.get(SyncService).purgeExpired()).tombstones).toBe(1);
    const gone = await http().get(`/v1/sync/pull?cursor=${p1.cursor}`).set(a);
    expect(gone.status).toBe(410);
    expect(gone.body.code).toBe('SYNC_RESET_REQUIRED');
    expect((await http().get('/v1/sync/pull').set(a)).status).toBe(200);
  });

  it('refuses a revoked device and exports favorites', async () => {
    const a = await bearer('sync-a');
    const exp = (await http().get('/v1/me/export').set(a).expect(200)).body;
    expect(exp.favorites).toEqual([{ stationId: jazz, order: 0, updatedAt: expect.any(String) }]);
    await t.pool.query('UPDATE devices SET revoked_at = now() WHERE id = $1', [phone]);
    expect((await http().get(`/v1/sync/pull?deviceId=${phone}`).set(a)).body.code).toBe('DEVICE_REVOKED');
    expect((await http().post('/v1/sync/push').set(a).send({ deviceId: phone, changes: [fav(randomUUID(), news, 0)] })).status).toBe(403);
  });

  it('removes audit records only past 180 days, and only from the retention job', async () => {
    await t.pool.query(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update`);
    await t.pool.query(`INSERT INTO audit_events (occurred_at, actor, action, target_type, target_id) VALUES (now() - interval '181 days', 'x', 'old.event', 't', '1'), (now() - interval '179 days', 'x', 'recent.event', 't', '2')`);
    await t.pool.query(`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update`);
    // Without the retention switch even an old row cannot be removed, and no row can ever be changed.
    await expect(t.pool.query(`DELETE FROM audit_events WHERE action = 'old.event'`)).rejects.toThrow(/append-only/);
    await expect(t.pool.query(`UPDATE audit_events SET reason = 'x' WHERE action = 'old.event'`)).rejects.toThrow(/append-only/);
    expect(await t.app.get(AuditRetentionService).run()).toBe(1);
    const left = (await t.pool.query(`SELECT action, changes FROM audit_events WHERE action IN ('old.event', 'recent.event', 'audit.retention') ORDER BY id`)).rows;
    expect(left).toEqual([
      { action: 'recent.event', changes: {} },
      { action: 'audit.retention', changes: { removed: 1, olderThanDays: 180 } },
    ]);
  });
});
