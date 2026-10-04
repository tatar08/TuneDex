import request from 'supertest';
import { Database } from '../src/db/database';
import { runStaffCli } from '../src/staff/staff-cli';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

const station = {
  name: 'Bangkok Jazz FM',
  country: 'TH',
  language: 'th',
  genres: ['jazz'],
  streamUrl: 'https://stream.example.com/jazz.mp3',
  codec: 'mp3',
  bitrateKbps: 128,
};

const record = {
  holder: 'Bangkok Jazz Co., Ltd.',
  basis: 'owner_permission',
  reference: 'CONTRACT-2026-014',
  territories: ['TH'],
  validFrom: '2026-01-01',
  expiresAt: null,
  evidenceRefs: ['rights/2026/contract-014.pdf'],
};

describe('station catalog', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let tokens: Record<'editor' | 'admin' | 'admin2' | 'user', string>;
  const http = () => request(t.app.getHttpServer());
  const as = (who: keyof typeof tokens) => ({ Authorization: `Bearer ${tokens[who]}` });
  const out: string[] = [];
  const staff = (...args: string[]) => runStaffCli(args, new Database(t.pool), (l) => out.push(l));

  const addRights = (sid: string, body: object = record, who: keyof typeof tokens = 'editor') =>
    http().post(`/v1/admin/stations/${sid}/rights`).set(as(who)).send(body);
  const revoke = (sid: string, rid: string, body: object = { reason: 'contract terminated by the owner' }, who: keyof typeof tokens = 'editor') =>
    http().post(`/v1/admin/stations/${sid}/rights/${rid}/revoke`).set(as(who)).send(body);
  /** Creates a draft and, unless `rights` is null, gives it a current rights record for TH. */
  const create = async (who: keyof typeof tokens, body: object = station, rights: object | null = record) => {
    const res = await http().post('/v1/admin/stations').set(as(who)).send(body);
    if (res.status === 201 && rights) await addRights(res.body.id, rights).expect(201);
    return res;
  };
  const patch = (who: keyof typeof tokens, sid: string, rev: number, body: object) =>
    http().patch(`/v1/admin/stations/${sid}`).set(as(who)).set('If-Match', `"${rev}"`).send(body);
  const publish = (who: keyof typeof tokens, sid: string, rev: number, reason = 'reviewed stream and rights') =>
    http().post(`/v1/admin/stations/${sid}/publish`).set(as(who)).set('If-Match', `"${rev}"`).send({ reason });
  const catalog = (q = '') => http().get(`/v1/catalog/radio${q}`);

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
    tokens = {
      editor: await id.token('staff-editor'),
      admin: await id.token('staff-admin'),
      admin2: await id.token('staff-admin-2'),
      user: await id.token('plain-user'),
    };
    expect(await staff('grant', 'staff-editor', 'catalog_editor', '--by', 'tar', '--reason', 'catalog team')).toBe(0);
    expect(await staff('grant', 'staff-admin', 'admin', '--by', 'tar', '--reason', 'reviewer')).toBe(0);
    expect(await staff('grant', 'staff-admin-2', 'admin', '--by', 'tar', '--reason', 'reviewer')).toBe(0);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  describe('roles', () => {
    it('keeps signed-out callers and ordinary users out of every admin route', async () => {
      expect((await http().get('/v1/admin/stations')).status).toBe(401);
      for (const res of [
        await http().get('/v1/admin/stations').set(as('user')),
        await create('user'),
        await http().get('/v1/admin/stations/0b9a4f8e-6c1d-4e2a-9f3b-1a2b3c4d5e6f').set(as('user')),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ROLE_REQUIRED');
      }
    });

    it('lets editors draft but not publish, disable or enable', async () => {
      const created = await create('editor');
      expect(created.status).toBe(201);
      const sid = created.body.id;
      expect((await publish('editor', sid, 1)).status).toBe(403);
      expect((await http().post(`/v1/admin/stations/${sid}/disable`).set(as('editor')).send({ reason: 'x' })).status).toBe(403);
      expect((await http().post(`/v1/admin/stations/${sid}/enable`).set(as('editor')).send({ reason: 'x' })).status).toBe(403);
    });

    it('stops working as soon as the role is revoked', async () => {
      await staff('grant', 'temp-editor', 'catalog_editor', '--by', 'tar', '--reason', 'temp');
      const token = await id.token('temp-editor');
      expect((await http().get('/v1/admin/stations').set('Authorization', `Bearer ${token}`)).status).toBe(200);
      expect(await staff('revoke', 'temp-editor', 'catalog_editor', '--by', 'tar', '--reason', 'left team')).toBe(0);
      expect((await http().get('/v1/admin/stations').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    });

    it('tells each caller their own current roles', async () => {
      expect((await http().get('/v1/me/staff').set(as('editor'))).body).toMatchObject({ roles: ['catalog_editor'], mfa: true });
      expect((await http().get('/v1/me/staff').set(as('user'))).body).toMatchObject({ roles: [], mfa: false });
      expect((await http().get('/v1/me/staff')).status).toBe(401);
    });

    it('refuses unknown roles and duplicate grants in the CLI', async () => {
      expect(await staff('grant', 'x', 'superuser', '--by', 'tar', '--reason', 'r')).toBe(2);
      expect(await staff('grant', 'staff-admin', 'admin', '--by', 'tar', '--reason', 'again')).toBe(1);
      expect(await staff('grant', 'x', 'admin')).toBe(2);
    });
  });

  describe('draft → publish', () => {
    it('serves nothing publicly until a different admin publishes, then serves only the published snapshot', async () => {
      const created = await create('editor', { ...station, name: 'Draft Only FM' });
      const sid = created.body.id;
      expect(created.body).toMatchObject({ revision: 1, status: 'draft', published: null });
      expect((await catalog()).body.stations.find((s: { id: string }) => s.id === sid)).toBeUndefined();

      const published = await publish('admin', sid, 1);
      expect(published.status).toBe(200);
      expect(published.body).toMatchObject({ status: 'published', publishedRevision: 1 });

      // An edit after publishing does not change what the apps see until it is published again.
      const edited = await patch('editor', sid, 1, { name: 'Renamed FM' });
      expect(edited.body).toMatchObject({ revision: 2, status: 'changes_pending' });
      const pub = (await catalog()).body.stations.find((s: { id: string }) => s.id === sid);
      expect(pub).toEqual({
        id: sid,
        revision: 1,
        name: 'Draft Only FM',
        country: 'TH',
        language: 'th',
        genres: ['jazz'],
        streamUrl: 'https://stream.example.com/jazz.mp3',
        codec: 'mp3',
        bitrateKbps: 128,
      });
    });

    it('never lets someone publish a change they made themselves', async () => {
      const created = await create('admin');
      const sid = created.body.id;
      expect(created.body.publishBlockers).toContain('own_change');
      const own = await publish('admin', sid, 1);
      expect(own.status).toBe(409);
      expect(own.body).toMatchObject({ code: 'PUBLISH_BLOCKED', details: { reasons: ['own_change'] } });

      // Another admin's edit does not clear the first admin's authorship.
      await patch('admin2', sid, 1, { genres: ['jazz', 'news'] }).expect(200);
      expect((await publish('admin', sid, 2)).body.details.reasons).toEqual(['own_change']);
      expect((await publish('admin2', sid, 2)).body.details.reasons).toEqual(['own_change']);

      // After an independent publish, authorship resets for the next round.
      const editorDraft = await create('editor');
      await publish('admin2', editorDraft.body.id, 1).expect(200);
      await patch('editor', editorDraft.body.id, 1, { bitrateKbps: 64 }).expect(200);
      await publish('admin', editorDraft.body.id, 2).expect(200);
    });

    it('lets an admin publish their own change alone only as a reviewed emergency (Doc 17)', async () => {
      const sid = (await create('admin')).body.id;
      const emergency = (reason: string, by: keyof typeof tokens = 'admin') =>
        http().post(`/v1/admin/stations/${sid}/publish`).set(as(by)).set('If-Match', '"1"').send({ reason, emergency: true });
      // A short reason is not enough to explain skipping the second admin.
      expect((await emergency('urgent')).body).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'reason', reason: 'too_short' } });
      expect((await http().post(`/v1/admin/stations/${sid}/publish`).set(as('admin')).set('If-Match', '"1"').send({ reason: 'x'.repeat(30), emergency: 'yes' })).status).toBe(400);
      // Editors still cannot publish, emergency or not.
      expect((await emergency('the stream moved and listeners cannot play it', 'editor')).status).toBe(403);

      const done = await emergency('the stream moved and listeners cannot play it').expect(200);
      expect(done.body.status).toBe('published');
      const [row] = (await t.pool.query(`SELECT action, reason, changes FROM audit_events WHERE target_id = $1 AND action LIKE 'station.publish%'`, [sid])).rows;
      expect(row).toMatchObject({ action: 'station.publish_emergency', reason: 'the stream moved and listeners cannot play it', changes: { emergency: true, reviewer: 'none' } });

      // An emergency flag on an ordinary review is recorded as an ordinary publish.
      const other = (await create('editor')).body.id;
      await http().post(`/v1/admin/stations/${other}/publish`).set(as('admin')).set('If-Match', '"1"').send({ reason: 'reviewed by a second admin anyway', emergency: true }).expect(200);
      expect((await t.pool.query(`SELECT action FROM audit_events WHERE target_id = $1 AND action LIKE 'station.publish%'`, [other])).rows).toEqual([{ action: 'station.publish' }]);
    });

    it('publishes only the revision the reviewer saw', async () => {
      const sid = (await create('editor')).body.id;
      await patch('editor', sid, 1, { name: 'Changed after review' });
      const stale = await publish('admin', sid, 1);
      expect(stale.status).toBe(412);
      expect(stale.body.details.currentRevision).toBe(2);
      expect((await http().post(`/v1/admin/stations/${sid}/publish`).set(as('admin')).send({ reason: 'ok' })).status).toBe(428);
    });

    it('requires a reason to publish', async () => {
      const sid = (await create('editor')).body.id;
      expect((await publish('admin', sid, 1, '')).status).toBe(400);
      expect((await http().post(`/v1/admin/stations/${sid}/publish`).set(as('admin')).set('If-Match', '"1"').send({})).status).toBe(400);
    });

    it('blocks publishing without an active, current rights record covering the station country', async () => {
      const reasons = async (rights: object | null, body: object = station) => {
        const sid = (await create('editor', body, rights)).body.id;
        return (await publish('admin', sid, 1)).body.details?.reasons;
      };
      expect(await reasons(null)).toEqual(['rights_missing']);
      expect(await reasons({ ...record, territories: ['LA', 'MM'] })).toEqual(['rights_territory']);
      expect(await reasons({ ...record, validFrom: '2020-01-01', expiresAt: '2020-12-31' })).toEqual(['rights_expired']);
      expect(await reasons({ ...record, validFrom: '2099-01-01' })).toEqual(['rights_not_yet_valid']);
      expect(await reasons({ ...record, territories: ['LA', 'TH'] }, { ...station, country: 'LA' })).toBeUndefined();

      // A revoked record no longer counts; the view shows the same blocker before anyone tries to publish.
      const sid = (await create('editor')).body.id;
      const [rec] = (await http().get(`/v1/admin/stations/${sid}/rights`).set(as('editor'))).body.records;
      await revoke(sid, rec.id).expect(200);
      const view = (await http().get(`/v1/admin/stations/${sid}`).set(as('admin'))).body;
      expect(view.publishBlockers).toEqual(['rights_missing']);
      expect(view.rights).toMatchObject({ state: 'missing' });

      // Changing the draft country away from the record's territory blocks the next publish.
      const moved = (await create('editor')).body.id;
      await patch('editor', moved, 1, { country: 'LA' }).expect(200);
      expect((await publish('admin', moved, 2)).body.details.reasons).toEqual(['rights_territory']);
    });

    it('rejects the old inline rights fields on a station', async () => {
      for (const field of ['rightsBasis', 'rightsReference', 'rightsExpiresAt']) {
        const res = await create('editor', { ...station, [field]: null });
        expect(res.status).toBe(400);
        expect(res.body.details).toMatchObject({ field, reason: 'unknown_field' });
      }
    });

    it('drops a station from the public catalog once its rights expire, without anyone acting', async () => {
      const sid = (await create('editor', { ...station, name: 'Expiring FM' }, { ...record, expiresAt: '2099-12-31' })).body.id;
      await publish('admin', sid, 1).expect(200);
      expect((await t.pool.query('SELECT rights_expires_at FROM radio_stations WHERE id = $1', [sid])).rows[0].rights_expires_at.toISOString()).toBe('2099-12-31T23:59:59.999Z');
      expect((await catalog('?limit=100')).body.stations.some((s: { id: string }) => s.id === sid)).toBe(true);
      // Simulate the date passing.
      await t.pool.query(`UPDATE radio_stations SET rights_expires_at = now() - interval '1 second' WHERE id = $1`, [sid]);
      expect((await catalog('?limit=100')).body.stations.some((s: { id: string }) => s.id === sid)).toBe(false);
    });

    it('rejects a stale draft edit with 412 and the current revision', async () => {
      const sid = (await create('editor')).body.id;
      await patch('editor', sid, 1, { name: 'A' }).expect(200);
      const stale = await patch('admin', sid, 1, { name: 'B' });
      expect(stale.status).toBe(412);
      expect(stale.body.details.currentRevision).toBe(2);
    });
  });

  describe('rights records', () => {
    const inCatalog = async (sid: string) => (await catalog('?limit=100')).body.stations.some((s: { id: string }) => s.id === sid);

    it('lets editors and admins read and change rights, nobody else', async () => {
      const sid = (await create('editor')).body.id;
      for (const res of [
        await http().get(`/v1/admin/stations/${sid}/rights`).set(as('user')),
        await addRights(sid, record, 'user'),
        await http().get(`/v1/admin/stations/${sid}/history`).set(as('user')),
      ]) {
        expect(res.status).toBe(403);
      }
      expect((await http().get(`/v1/admin/stations/${sid}/rights`)).status).toBe(401);
      expect((await addRights(sid, record, 'admin')).status).toBe(201);
      expect((await http().get('/v1/admin/stations/0b9a4f8e-6c1d-4e2a-9f3b-1a2b3c4d5e6f/rights').set(as('editor'))).status).toBe(404);
      expect((await addRights('0b9a4f8e-6c1d-4e2a-9f3b-1a2b3c4d5e6f')).status).toBe(404);
    });

    it('keeps evidence keys in the staff list only', async () => {
      const sid = (await create('editor', station, null)).body.id;
      const added = await addRights(sid, { ...record, evidenceRefs: ['rights/2026/contract-014.pdf', 'mail/thread-77'] });
      expect(added.status).toBe(201);
      expect(added.headers['cache-control']).toBe('no-store');
      expect(added.body).toMatchObject({ holder: record.holder, territories: ['TH'], status: 'active', effectiveStatus: 'active', evidenceCount: 2 });
      expect(added.body).not.toHaveProperty('evidenceRefs');
      expect(added.body.createdBy).toBe('staff-editor');

      const list = (await http().get(`/v1/admin/stations/${sid}/rights`).set(as('editor'))).body.records;
      expect(list).toHaveLength(1);
      expect(list[0].evidenceRefs).toEqual(['rights/2026/contract-014.pdf', 'mail/thread-77']);

      const [audit] = (await t.pool.query(`SELECT changes FROM audit_events WHERE target_id = $1 AND action = 'rights.add'`, [sid])).rows;
      expect(audit.changes).toMatchObject({ recordId: added.body.id, basis: 'owner_permission', territories: ['TH'], evidenceCount: 2 });
      expect(JSON.stringify(audit.changes)).not.toMatch(/contract-014\.pdf|thread-77|Bangkok Jazz Co/);

      await publish('admin', sid, 1).expect(200);
      const raw = JSON.stringify((await catalog('?limit=100')).body);
      expect(raw).not.toMatch(/contract-014|thread-77|Bangkok Jazz Co|evidence/);
    });

    it('takes a station out of the catalog as soon as its only record is revoked, and back when rights are added', async () => {
      const sid = (await create('editor', { ...station, name: 'Revoked FM' })).body.id;
      await publish('admin', sid, 1).expect(200);
      expect(await inCatalog(sid)).toBe(true);
      const [rec] = (await http().get(`/v1/admin/stations/${sid}/rights`).set(as('editor'))).body.records;

      expect((await revoke(sid, rec.id, {})).status).toBe(400);
      const revoked = await revoke(sid, rec.id);
      expect(revoked.status).toBe(200);
      expect(revoked.body).toMatchObject({ status: 'revoked', effectiveStatus: 'revoked', revokeReason: 'contract terminated by the owner', revokedBy: 'staff-editor' });
      expect(await inCatalog(sid)).toBe(false);
      expect((await revoke(sid, rec.id)).body.code).toBe('RIGHTS_ALREADY_REVOKED');

      const [audit] = (await t.pool.query(`SELECT reason, changes FROM audit_events WHERE target_id = $1 AND action = 'rights.revoke'`, [sid])).rows;
      expect(audit).toMatchObject({ reason: 'contract terminated by the owner', changes: { recordId: rec.id, hidden: true } });

      // A new record covering the country brings the published snapshot back without a new publish.
      await addRights(sid, { ...record, reference: 'CONTRACT-2026-099', expiresAt: '2099-06-30' }).expect(201);
      expect(await inCatalog(sid)).toBe(true);
      // Records for other territories, or not yet valid, do not.
      const second = (await http().get(`/v1/admin/stations/${sid}/rights`).set(as('editor'))).body.records[0];
      await addRights(sid, { ...record, territories: ['LA'] }).expect(201);
      await addRights(sid, { ...record, validFrom: '2099-01-01' }).expect(201);
      await revoke(sid, second.id).expect(200);
      expect(await inCatalog(sid)).toBe(false);
      const view = (await http().get(`/v1/admin/stations/${sid}`).set(as('editor'))).body;
      expect(view.rights).toMatchObject({ state: 'not_yet_valid', expiresAt: null });
    });

    it('revokes only a record of the same station', async () => {
      const a = (await create('editor')).body.id;
      const b = (await create('editor')).body.id;
      const [rec] = (await http().get(`/v1/admin/stations/${a}/rights`).set(as('editor'))).body.records;
      expect((await revoke(b, rec.id)).status).toBe(404);
      expect((await revoke(a, 'not-a-uuid')).body.details).toMatchObject({ field: 'recordId', reason: 'must_be_uuid' });
    });

    it.each([
      ['missing holder', { holder: undefined }, 'holder', 'required'],
      ['basis', { basis: 'trust_me' }, 'basis', 'value_not_allowed'],
      ['empty territories', { territories: [] }, 'territories', 'length'],
      ['lower-case territory', { territories: ['th'] }, 'territories', 'iso_3166_alpha2'],
      ['date format', { validFrom: '01/01/2026' }, 'validFrom', 'date_yyyy_mm_dd'],
      ['impossible date', { expiresAt: '2026-02-30' }, 'expiresAt', 'date_yyyy_mm_dd'],
      ['expiry before start', { validFrom: '2026-06-01', expiresAt: '2026-05-31' }, 'expiresAt', 'before_valid_from'],
      ['evidence url', { evidenceRefs: ['https://files.example.com/contract.pdf'] }, 'evidenceRefs', 'opaque_key'],
      ['evidence traversal', { evidenceRefs: ['rights/../secrets'] }, 'evidenceRefs', 'opaque_key'],
      ['too much evidence', { evidenceRefs: Array.from({ length: 11 }, (_, i) => `k${i}`) }, 'evidenceRefs', 'max_10'],
      ['unknown field', { status: 'active' }, 'status', 'unknown_field'],
    ])('rejects a record with %s', async (_label, override, field, reason) => {
      const sid = (await create('editor', station, null)).body.id;
      const res = await addRights(sid, JSON.parse(JSON.stringify({ ...record, ...override })));
      expect(res.status).toBe(400);
      expect(res.body.details).toMatchObject({ field, reason });
    });
  });

  describe('history', () => {
    it('lists station and rights changes newest first, in cursor pages', async () => {
      const sid = (await create('editor', { ...station, name: 'History FM' })).body.id;
      await patch('editor', sid, 1, { bitrateKbps: 64 }).expect(200);
      await publish('admin', sid, 2, 'checked the contract').expect(200);
      const [rec] = (await http().get(`/v1/admin/stations/${sid}/rights`).set(as('editor'))).body.records;
      await revoke(sid, rec.id).expect(200);

      const all = await http().get(`/v1/admin/stations/${sid}/history`).set(as('editor'));
      expect(all.status).toBe(200);
      expect(all.headers['cache-control']).toBe('no-store');
      expect(all.body.nextCursor).toBeNull();
      expect(all.body.events.map((e: { action: string }) => e.action)).toEqual(['rights.revoke', 'station.publish', 'station.update', 'rights.add', 'station.create']);
      expect(all.body.events[1]).toMatchObject({ actorSubject: 'staff-admin', reason: 'checked the contract', revision: 2 });
      expect(all.body.events[0]).toMatchObject({ actorSubject: 'staff-editor', reason: 'contract terminated by the owner', revision: null });
      expect(JSON.stringify(all.body)).not.toContain('contract-014.pdf');

      const first = (await http().get(`/v1/admin/stations/${sid}/history?limit=2`).set(as('admin'))).body;
      expect(first.events.map((e: { action: string }) => e.action)).toEqual(['rights.revoke', 'station.publish']);
      const second = (await http().get(`/v1/admin/stations/${sid}/history?limit=2&cursor=${first.nextCursor}`).set(as('admin'))).body;
      expect(second.events.map((e: { action: string }) => e.action)).toEqual(['station.update', 'rights.add']);

      expect((await http().get(`/v1/admin/stations/${sid}/history?limit=101`).set(as('admin'))).status).toBe(400);
      expect((await http().get(`/v1/admin/stations/${sid}/history?cursor=bad!`).set(as('admin'))).status).toBe(400);
      expect((await http().get('/v1/admin/stations/0b9a4f8e-6c1d-4e2a-9f3b-1a2b3c4d5e6f/history').set(as('admin'))).status).toBe(404);
    });
  });

  describe('disable and enable', () => {
    it('hides a station from the apps immediately and brings it back', async () => {
      const sid = (await create('editor', { ...station, name: 'Toggle FM' })).body.id;
      await publish('admin', sid, 1).expect(200);
      const disabled = await http().post(`/v1/admin/stations/${sid}/disable`).set(as('admin')).send({ reason: 'stream down for 3 checks' });
      expect(disabled.body.status).toBe('disabled');
      expect((await catalog('?limit=100')).body.stations.some((s: { id: string }) => s.id === sid)).toBe(false);
      await http().post(`/v1/admin/stations/${sid}/enable`).set(as('admin')).send({ reason: 'stream back' }).expect(200);
      expect((await catalog('?limit=100')).body.stations.some((s: { id: string }) => s.id === sid)).toBe(true);
    });
  });

  describe('validation', () => {
    it.each([
      ['http stream', { streamUrl: 'http://stream.example.com/a.mp3' }, 'streamUrl', 'https_required'],
      ['ip literal', { streamUrl: 'https://10.0.0.5/a.mp3' }, 'streamUrl', 'ip_literal_not_allowed'],
      ['ipv6 literal', { streamUrl: 'https://[::1]/a.mp3' }, 'streamUrl', 'ip_literal_not_allowed'],
      ['localhost', { streamUrl: 'https://localhost/a.mp3' }, 'streamUrl', 'private_host'],
      ['internal name', { streamUrl: 'https://radio.internal/a.mp3' }, 'streamUrl', 'private_host'],
      ['credentials', { streamUrl: 'https://u:p@stream.example.com/a.mp3' }, 'streamUrl', 'credentials_not_allowed'],
      ['odd port', { streamUrl: 'https://stream.example.com:8443/a.mp3' }, 'streamUrl', 'nonstandard_port'],
      ['not a url', { streamUrl: 'javascript:alert(1)' }, 'streamUrl', 'https_required'],
      ['control chars', { name: 'Bad‮FM' }, 'name', 'control_characters'],
      ['long name', { name: 'x'.repeat(81) }, 'name', 'length'],
      ['country', { country: 'tha' }, 'country', 'iso_3166_alpha2'],
      ['codec', { codec: 'flac' }, 'codec', 'value_not_allowed'],
      ['genres', { genres: ['a b'] }, 'genres', 'slug'],
      ['bitrate', { bitrateKbps: 1000 }, 'bitrateKbps', 'out_of_range'],
      ['unknown field', { createdBy: 'someone' }, 'createdBy', 'unknown_field'],
    ])('rejects %s', async (_label, override, field, reason) => {
      const res = await create('editor', { ...station, ...override });
      expect(res.status).toBe(400);
      expect(res.body.details).toMatchObject({ field, reason });
    });

    it('requires the core fields on create', async () => {
      const { name: _n, ...rest } = station;
      expect((await create('editor', rest)).body.details).toMatchObject({ field: 'name', reason: 'required' });
    });

    it('returns 404 for an unknown station and 400 for a malformed id', async () => {
      expect((await http().get('/v1/admin/stations/0b9a4f8e-6c1d-4e2a-9f3b-1a2b3c4d5e6f').set(as('editor'))).status).toBe(404);
      expect((await http().get('/v1/admin/stations/123').set(as('editor'))).status).toBe(400);
    });
  });

  describe('public catalog', () => {
    it('needs no sign-in, pages with an opaque cursor and supports conditional requests', async () => {
      const first = await catalog('?limit=2');
      expect(first.status).toBe(200);
      expect(first.headers['cache-control']).toBe('public, max-age=300');
      expect(first.body.stations).toHaveLength(2);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const second = await catalog(`?limit=2&cursor=${first.body.nextCursor}`);
      expect(second.body.stations[0].id > first.body.stations[1].id).toBe(true);

      const again = await catalog('?limit=2').set('If-None-Match', first.headers.etag);
      expect(again.status).toBe(304);
      expect((await catalog('?cursor=not-a-cursor!')).status).toBe(400);
      expect((await catalog('?limit=abc')).status).toBe(400);
    });

    it('never exposes rights details or drafts', async () => {
      const raw = JSON.stringify((await catalog('?limit=100')).body);
      expect(raw).not.toContain('CONTRACT-');
      expect(raw).not.toContain('rights');
      expect(raw).not.toContain('Renamed FM');
    });
  });

  describe('audit trail', () => {
    it('records every catalog and role change with actor and reason, and cannot be edited', async () => {
      const sid = (await create('editor', { ...station, name: 'Audited FM' })).body.id;
      await publish('admin', sid, 1, 'checked contract CONTRACT-2026-014').expect(200);
      const rows = (
        await t.pool.query(`SELECT actor, action, reason, changes FROM audit_events WHERE target_id = $1 ORDER BY id`, [sid])
      ).rows;
      expect(rows.map((r) => r.action)).toEqual(['station.create', 'rights.add', 'station.publish']);
      expect(rows[0].actor).toMatch(/^user:[0-9a-f-]{36}$/);
      expect(rows[2]).toMatchObject({ reason: 'checked contract CONTRACT-2026-014', changes: { revision: 1, previousPublishedRevision: null } });

      const roles = (await t.pool.query(`SELECT actor, action FROM audit_events WHERE action LIKE 'staff_role.%'`)).rows;
      expect(roles).toContainEqual({ actor: 'operator:tar', action: 'staff_role.revoke' });

      await expect(t.pool.query('DELETE FROM audit_events')).rejects.toThrow(/append-only/);
      await expect(t.pool.query(`UPDATE audit_events SET reason = 'x'`)).rejects.toThrow(/append-only/);
    });

    it('rolls the change back if the audit write fails', async () => {
      const before = (await t.pool.query('SELECT count(*)::int AS n FROM radio_stations')).rows[0].n;
      await t.pool.query(`ALTER TABLE audit_events ADD CONSTRAINT block_for_test CHECK (action <> 'station.create') NOT VALID`);
      try {
        expect((await create('editor')).status).toBe(500);
      } finally {
        await t.pool.query('ALTER TABLE audit_events DROP CONSTRAINT block_for_test');
      }
      expect((await t.pool.query('SELECT count(*)::int AS n FROM radio_stations')).rows[0].n).toBe(before);
    });
  });
});
