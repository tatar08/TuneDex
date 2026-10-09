import request from 'supertest';
import { Database } from '../src/db/database';
import { toDirectoryStation } from '../src/directory/directory';
import { runStaffCli } from '../src/staff/staff-cli';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

const BASE = 'https://rb.example.test';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A Radio Browser record as /json/stations/search returns it. */
const rb = (n: number, over: Record<string, unknown> = {}) => ({
  stationuuid: uuid(n),
  name: `Station ${n}`,
  url: `https://stream${n}.example.com/live`,
  url_resolved: `https://stream${n}.example.com/live.mp3`,
  homepage: `https://station${n}.example.com/`,
  favicon: `https://station${n}.example.com/logo.png`,
  tags: 'jazz,Smooth Jazz,  ,jazz',
  countrycode: 'TH',
  language: 'thai,english',
  codec: 'MP3',
  bitrate: 128,
  hls: 0,
  lastcheckok: 1,
  ...over,
});

describe('community radio directory (Radio Browser)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let off: Awaited<ReturnType<typeof createTestApp>>;
  const calls: { url: string; ua: string }[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: [] };
  let tokens: Record<'editor' | 'admin' | 'ops' | 'user', string>;
  const http = () => request(t.app.getHttpServer());
  const as = (who: keyof typeof tokens) => ({ Authorization: `Bearer ${tokens[who]}` });
  const staff = (...args: string[]) => runStaffCli(args, new Database(t.pool), () => undefined);

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver, {
      config: { radioDirectory: { baseUrl: BASE } },
      directoryFetch: async (url, init) => {
        calls.push({ url, ua: init.headers['user-agent'] });
        const { status, body } = reply;
        return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
      },
    });
    off = await createTestApp(db.url, id.keyResolver);
    tokens = {
      editor: await id.token('dir-editor'),
      admin: await id.token('dir-admin'),
      ops: await id.token('dir-ops'),
      user: await id.token('dir-user'),
    };
    expect(await staff('grant', 'dir-editor', 'catalog_editor', '--by', 'tar', '--reason', 'catalog team')).toBe(0);
    expect(await staff('grant', 'dir-admin', 'admin', '--by', 'tar', '--reason', 'reviewer')).toBe(0);
    expect(await staff('grant', 'dir-ops', 'operator', '--by', 'tar', '--reason', 'ops')).toBe(0);
  });
  afterAll(async () => {
    await t.close();
    await off.close();
    await db.drop();
  });
  beforeEach(() => {
    calls.length = 0;
  });

  it('answers 503 not_configured while RADIO_BROWSER_BASE_URL is unset', async () => {
    const res = await request(off.app.getHttpServer()).get('/v1/directory/radio?q=jazz');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', details: { dependency: 'radio_directory', reason: 'not_configured' } });
  });

  it('searches without sign-in, maps each station, and passes the filters on', async () => {
    reply = { status: 200, body: [rb(1), rb(2, { codec: 'AAC+', bitrate: 0, favicon: 'http://insecure.example.com/x.png', countrycode: 'th' })] };
    const res = await http().get('/v1/directory/radio?q=%20Jazz%20&country=th&language=Thai&tag=Jazz&limit=2&offset=4').expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body.attribution).toMatch(/Radio Browser/);
    expect(res.body.nextOffset).toBe(6);
    expect(res.body.stations).toEqual([
      {
        id: uuid(1),
        name: 'Station 1',
        country: 'TH',
        language: 'thai',
        genres: ['jazz', 'smooth jazz'],
        streamUrl: 'https://stream1.example.com/live.mp3',
        codec: 'mp3',
        bitrateKbps: 128,
        logoUrl: 'https://station1.example.com/logo.png',
        homepageUrl: 'https://station1.example.com/',
      },
      expect.objectContaining({ id: uuid(2), codec: 'aac', bitrateKbps: null, logoUrl: null, country: null }),
    ]);
    const url = new URL(calls[0].url);
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/json/stations/search`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      hidebroken: 'true',
      is_https: 'true',
      order: 'clickcount',
      reverse: 'true',
      limit: '2',
      offset: '4',
      name: 'Jazz',
      countrycode: 'TH',
      language: 'thai',
      tag: 'jazz',
    });
    expect(calls[0].ua).toBe('TuneDeck-API/test');
  });

  it('returns coordinates only for hasGeo=true, dropping stations without usable ones', async () => {
    calls.length = 0;
    reply = { status: 200, body: [rb(31, { geo_lat: 13.756331, geo_long: 100.501762 }), rb(32, { geo_lat: 0, geo_long: 0 }), rb(33, { geo_lat: 95, geo_long: 10 }), rb(34)] };
    const res = await http().get('/v1/directory/radio?hasGeo=true&country=TH').expect(200);
    expect(res.body.stations).toHaveLength(1);
    expect(res.body.stations[0]).toMatchObject({ id: uuid(31), geo: { lat: 13.76, lon: 100.5 } });
    expect(new URL(calls[0].url).searchParams.get('has_geo_info')).toBe('true');
    // Without it the shape the apps already parse is unchanged.
    reply = { status: 200, body: [rb(35, { geo_lat: 13.7, geo_long: 100.5 })] };
    const plain = await http().get('/v1/directory/radio?country=TH&tag=geo-off').expect(200);
    expect(plain.body.stations[0].geo).toBeUndefined();
    await http().get('/v1/directory/radio?hasGeo=yes').expect(400);
  });

  it('counts stations per country from Radio Browser and caches the answer', async () => {
    calls.length = 0;
    reply = { status: 200, body: [{ name: 'Thailand', iso_3166_1: 'TH', stationcount: 120 }, { name: 'Japan', iso_3166_1: 'jp', stationcount: 300 }, { name: 'Nowhere', iso_3166_1: '', stationcount: 5 }, { name: 'Empty', iso_3166_1: 'ZZ', stationcount: 0 }] };
    const res = await http().get('/v1/directory/radio/countries').expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.body.countries).toEqual([
      { country: 'JP', stations: 300 },
      { country: 'TH', stations: 120 },
    ]);
    expect(calls[0].url).toBe(`${BASE}/json/countries?hidebroken=true`);
    reply = { status: 500, body: 'down' };
    expect((await http().get('/v1/directory/radio/countries').expect(200)).body.countries).toHaveLength(2);
    expect(calls).toHaveLength(1);
    await http().get('/v1/directory/radio/countries?x=1').expect(400);
    await request(off.app.getHttpServer()).get('/v1/directory/radio/countries').expect(503);
  });

  it('drops streams the players cannot use or that break our stream rules', () => {
    expect(toDirectoryStation(rb(1, { url_resolved: 'http://stream.example.com/a.mp3' }))).toBeNull();
    expect(toDirectoryStation(rb(1, { url_resolved: 'https://10.1.2.3/a.mp3' }))).toBeNull();
    expect(toDirectoryStation(rb(1, { url_resolved: 'https://radio.local/a.mp3' }))).toBeNull();
    expect(toDirectoryStation(rb(1, { url_resolved: 'https://stream.example.com:8443/a.mp3' }))).toBeNull();
    expect(toDirectoryStation(rb(1, { codec: 'OGG' }))).toBeNull();
    expect(toDirectoryStation(rb(1, { name: ' ‮ ' }))).toBeNull();
    expect(toDirectoryStation(rb(1, { stationuuid: 'not-a-uuid' }))).toBeNull();
    expect(toDirectoryStation(rb(1, { codec: 'UNKNOWN', hls: 1 }))?.codec).toBe('hls');
    expect(toDirectoryStation(rb(1, { url_resolved: '' }))?.streamUrl).toBe('https://stream1.example.com/live');
    expect(toDirectoryStation(rb(1, { name: `A\u0007${'b'.repeat(100)}` }))?.name).toBe(`A${'b'.repeat(79)}`);
  });

  it('caches an answer for ten minutes and serves it while Radio Browser is down', async () => {
    reply = { status: 200, body: [rb(10)] };
    await http().get('/v1/directory/radio?q=cachecheck').expect(200);
    await http().get('/v1/directory/radio?q=cachecheck').expect(200);
    expect(calls).toHaveLength(1);
    reply = { status: 500, body: 'oops' };
    const fresh = await http().get('/v1/directory/radio?q=nevercached');
    expect(fresh.status).toBe(503);
    expect(fresh.body.details).toEqual({ dependency: 'radio_directory', reason: 'unreachable' });
    reply = { status: 200, body: { not: 'a list' } };
    expect((await http().get('/v1/directory/radio?q=oddshape')).status).toBe(503);
  });

  it('never logs the search text', async () => {
    reply = { status: 200, body: [rb(11)] };
    t.logs.mark();
    await http().get('/v1/directory/radio?q=privatesearchword').expect(200);
    reply = { status: 502, body: '' };
    await http().get('/v1/directory/radio?q=privatesearchword2');
    expect(t.logs.raw()).not.toMatch(/privatesearchword/);
    expect(t.logs.raw()).toMatch(/RADIO_DIRECTORY_UNAVAILABLE/);
  });

  it.each([
    ['unknown field', 'name=x'],
    ['blank search', 'q=%20%20'],
    ['long search', `q=${'x'.repeat(81)}`],
    ['country', 'country=THA'],
    ['limit', 'limit=51'],
    ['offset', 'offset=1001'],
    ['repeated', 'q=a&q=b'],
  ])('rejects %s', async (_label, qs) => {
    expect((await http().get(`/v1/directory/radio?${qs}`)).status).toBe(400);
  });

  it('lets editors and admins block a station or a host, which hides it at once, and lift the block', async () => {
    reply = { status: 200, body: [rb(20), rb(21), rb(22, { url_resolved: 'https://edge.blocked-host.example.com/live.mp3' })] };
    const ids = async () => (await http().get('/v1/directory/radio?q=blocks').expect(200)).body.stations.map((s: { id: string }) => s.id);
    expect(await ids()).toEqual([uuid(20), uuid(21), uuid(22)]);

    const station = await http().post('/v1/admin/directory/blocks').set(as('editor')).send({ kind: 'station', value: uuid(20).toUpperCase(), reason: 'rights holder asked us to remove it' });
    expect(station.status).toBe(201);
    expect(station.body).toMatchObject({ kind: 'station', value: uuid(20), createdBy: 'dir-editor' });
    await http().post('/v1/admin/directory/blocks').set(as('admin')).send({ kind: 'host', value: 'Blocked-Host.example.com.', reason: 'whole host is a pirate relay' }).expect(201);
    expect(await ids()).toEqual([uuid(21)]);

    const dup = await http().post('/v1/admin/directory/blocks').set(as('admin')).send({ kind: 'station', value: uuid(20), reason: 'second request for the same' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DIRECTORY_BLOCK_EXISTS');

    const list = (await http().get('/v1/admin/directory/blocks').set(as('editor')).expect(200)).body.blocks;
    expect(list.map((b: { value: string }) => b.value)).toEqual(['blocked-host.example.com', uuid(20)]);

    await http().post(`/v1/admin/directory/blocks/${station.body.id}/remove`).set(as('editor')).send({ reason: 'complaint withdrawn by owner' }).expect(204);
    expect(await ids()).toEqual([uuid(20), uuid(21)]);
    expect((await http().post(`/v1/admin/directory/blocks/${station.body.id}/remove`).set(as('editor')).send({ reason: 'complaint withdrawn by owner' })).status).toBe(404);

    const audit = await t.pool.query<{ action: string; reason: string }>(`SELECT action, reason FROM audit_events WHERE action LIKE 'directory.block.%' ORDER BY id`);
    expect(audit.rows).toEqual([
      { action: 'directory.block.add', reason: 'rights holder asked us to remove it' },
      { action: 'directory.block.add', reason: 'whole host is a pirate relay' },
      { action: 'directory.block.remove', reason: 'complaint withdrawn by owner' },
    ]);
  });

  it('refuses bad blocks and everyone without a catalog role', async () => {
    for (const body of [
      { kind: 'station', value: 'nope', reason: 'rights holder asked us' },
      { kind: 'host', value: 'https://x.example.com', reason: 'rights holder asked us' },
      { kind: 'host', value: '10.0.0.1', reason: 'rights holder asked us' },
      { kind: 'url', value: 'x.example.com', reason: 'rights holder asked us' },
      { kind: 'host', value: 'x.example.com', reason: 'short' },
      { kind: 'host', value: 'x.example.com', reason: 'rights holder asked us', extra: 1 },
    ]) {
      expect((await http().post('/v1/admin/directory/blocks').set(as('admin')).send(body)).status).toBe(400);
    }
    for (const who of ['ops', 'user'] as const) {
      expect((await http().get('/v1/admin/directory/blocks').set(as(who))).status).toBe(403);
      expect((await http().post('/v1/admin/directory/blocks').set(as(who)).send({ kind: 'host', value: 'x.example.com', reason: 'rights holder asked us' })).status).toBe(403);
    }
    expect((await http().get('/v1/admin/directory/blocks')).status).toBe(401);
    expect((await http().post('/v1/admin/directory/blocks/abc/remove').set(as('admin')).send({ reason: 'complaint withdrawn' })).status).toBe(400);
  });

  it('asks Radio Browser once for concurrent identical searches, and a trailing dot does not dodge a host block', async () => {
    reply = { status: 200, body: [rb(30), rb(31, { url_resolved: 'https://edge.dotted-host.example.com./live.mp3' })] };
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => http().get('/v1/directory/radio?q=stampede')));
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(calls).toHaveLength(1);
    await http().post('/v1/admin/directory/blocks').set(as('admin')).send({ kind: 'host', value: 'dotted-host.example.com', reason: 'complaint from rights holder' }).expect(201);
    expect((await http().get('/v1/directory/radio?q=stampede').expect(200)).body.stations.map((s: { id: string }) => s.id)).toEqual([uuid(30)]);
  });
});
