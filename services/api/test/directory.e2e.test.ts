import request from 'supertest';
import { Database } from '../src/db/database';
import { toDirectoryStation } from '../src/directory/directory';
import { imageSize, sniffImage } from '../src/directory/logos';
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
        const { status } = reply;
        const body = typeof reply.body === 'function' ? (reply.body as (u: URL) => unknown)(new URL(url)) : reply.body;
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
        customLogoVersion: null,
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

  it('lists every station of a country for the map in pages of 500, geo where known, blocked ones left out', async () => {
    const jp = (n: number) => rb(n, { countrycode: 'JP', geo_lat: n % 2 ? 35.68 : null, geo_long: n % 2 ? 139.69 : null });
    reply = { status: 200, body: (u: URL) => Array.from({ length: u.searchParams.get('offset') === '0' ? 500 : 120 }, (_, i) => jp(2000 + Number(u.searchParams.get('offset')) + i)) };
    await http().post('/v1/admin/directory/blocks').set(as('editor')).send({ kind: 'station', value: uuid(2001), reason: 'switched off by the catalog team' }).expect(201);
    const res = await http().get('/v1/directory/radio/map?country=jp').expect(200);
    expect(calls.map((c) => new URL(c.url).searchParams.get('offset'))).toEqual(['0', '500']);
    const asked = new URL(calls[0].url).searchParams;
    expect([asked.get('countrycode'), asked.get('limit'), asked.get('has_geo_info'), asked.get('is_https')]).toEqual(['JP', '500', null, 'true']);
    expect(res.body.stations).toHaveLength(619);
    expect(res.body.truncated).toBe(false);
    expect(res.body.stations[0]).toMatchObject({ id: uuid(2000) });
    expect(res.body.stations[0].geo).toBeUndefined();
    expect(res.body.stations[1]).toMatchObject({ id: uuid(2002) });
    expect(res.body.stations.find((s: { id: string }) => s.id === uuid(2003)).geo).toEqual({ lat: 35.68, lon: 139.69 });
    expect(res.headers['cache-control']).toBe('public, max-age=600');
    // Kept an hour: the next viewer costs Radio Browser nothing.
    await http().get('/v1/directory/radio/map?country=JP').expect(200);
    expect(calls).toHaveLength(2);
    expect((await http().get('/v1/directory/radio/map?country=JPN')).status).toBe(400);
    expect((await http().get('/v1/directory/radio/map?limit=5')).status).toBe(400);
  });

  it('builds the world map from the most listened stations plus every featured country with coordinates', async () => {
    reply = {
      status: 200,
      body: (u: URL) => {
        const cc = u.searchParams.get('countrycode');
        if (u.searchParams.get('has_geo_info') !== 'true') return [];
        if (!cc) return [rb(3000, { countrycode: 'BR', geo_lat: -23.5, geo_long: -46.6 })];
        if (cc === 'TH') return [rb(3001, { geo_lat: 13.75, geo_long: 100.5 }), rb(3000, { countrycode: 'BR', geo_lat: -23.5, geo_long: -46.6 })];
        if (cc === 'DE') return [rb(3002, { countrycode: 'DE', geo_lat: 52.5, geo_long: 13.4 })];
        return [];
      },
    };
    const res = await http().get('/v1/directory/radio/map').expect(200);
    const asked = calls.map((c) => new URL(c.url).searchParams.get('countrycode'));
    expect(asked).toEqual(expect.arrayContaining([null, 'TH', 'JP', 'KR', 'US', 'DE', 'FR', 'GB', 'IT', 'ES', 'RU']));
    expect(new URL(calls.find((c) => c.url.includes('countrycode=US'))!.url).searchParams.get('limit')).toBe('500');
    expect(res.body.stations.map((s: { id: string }) => s.id)).toEqual([uuid(3000), uuid(3001), uuid(3002)]);
    expect(res.body.stations[1].geo).toEqual({ lat: 13.75, lon: 100.5 });
  });

  it('adds the top 20 of every other country, and serves the world map without one country that failed', async () => {
    reply = {
      status: 200,
      body: (u: URL) => {
        if (u.pathname === '/json/countries') return [{ iso_3166_1: 'VN', stationcount: 40 }, { iso_3166_1: 'TH', stationcount: 300 }];
        const cc = u.searchParams.get('countrycode');
        if (cc === 'FR') return 'oops';
        if (cc === 'VN') return [rb(3101, { countrycode: 'VN', geo_lat: 21, geo_long: 105.8 })];
        return cc ? [] : [rb(3100, { geo_lat: 1, geo_long: 1 })];
      },
    };
    calls.length = 0;
    // A fresh service: the earlier test's world list is cached.
    const fresh = await createTestApp(db.url, id.keyResolver, { config: { radioDirectory: { baseUrl: BASE } }, directoryFetch: async (url) => {
      calls.push({ url, ua: '' });
      const body = (reply.body as (u: URL) => unknown)(new URL(url));
      return { status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
    } });
    try {
      const res = await request(fresh.app.getHttpServer()).get('/v1/directory/radio/map').expect(200);
      expect(res.body).toMatchObject({ truncated: true, stations: [{ id: uuid(3100) }, { id: uuid(3101) }] });
      const asked = calls.map((c) => new URL(c.url).searchParams);
      expect(asked.find((p) => p.get('countrycode') === 'VN')!.get('limit')).toBe('20');
      // Thailand is in full already, so it is not asked a second time for a top 20.
      expect(asked.filter((p) => p.get('countrycode') === 'TH')).toHaveLength(1);
    } finally {
      await fresh.close();
    }
  });

  it('lets staff list a country with each station on or off, and switch one off and on again', async () => {
    reply = { status: 200, body: () => [rb(4000, { countrycode: 'KR', name: 'Seoul FM' }), rb(4001, { countrycode: 'KR', name: 'Busan Jazz' }), rb(4002, { countrycode: 'KR', name: 'Seoul Talk', url_resolved: 'https://a.kr-host.example.com/x.mp3' })] };
    await http().post('/v1/admin/directory/blocks').set(as('admin')).send({ kind: 'host', value: 'kr-host.example.com', reason: 'host relays without rights' }).expect(201);
    const list = async (qs: string) => (await http().get(`/v1/admin/directory/stations?${qs}`).set(as('editor')).expect(200)).body;
    const all = await list('country=kr');
    expect(all.stations.map((s: { name: string; active: boolean; block: { kind: string } | null }) => [s.name, s.active, s.block?.kind ?? null])).toEqual([
      ['Seoul FM', true, null],
      ['Busan Jazz', true, null],
      ['Seoul Talk', false, 'host'],
    ]);
    expect(all).toMatchObject({ total: 3, nextOffset: null, truncated: false });
    const off = await http().post('/v1/admin/directory/blocks').set(as('editor')).send({ kind: 'station', value: uuid(4000), reason: 'switched off by the catalog team' }).expect(201);
    expect((await list('country=KR&status=inactive')).stations.map((s: { name: string }) => s.name)).toEqual(['Seoul FM', 'Seoul Talk']);
    expect((await list('country=KR&status=active&q=jazz')).stations.map((s: { name: string }) => s.name)).toEqual(['Busan Jazz']);
    expect((await http().get('/v1/directory/radio/map?country=KR').expect(200)).body.stations.map((s: { name: string }) => s.name)).toEqual(['Busan Jazz']);
    await http().post(`/v1/admin/directory/blocks/${off.body.id}/remove`).set(as('editor')).send({ reason: 'switched back on after review' }).expect(204);
    expect((await list('country=KR&status=active')).stations.map((s: { name: string }) => s.name)).toEqual(['Seoul FM', 'Busan Jazz']);
    const byName = await list('q=seoul');
    expect(new URL(calls.at(-1)!.url).searchParams.get('name')).toBe('seoul');
    expect(byName.total).toBe(3);

    for (const qs of ['', 'country=KOR', 'country=KR&status=maybe', 'country=KR&offset=5000', 'country=KR&limit=5']) {
      expect((await http().get(`/v1/admin/directory/stations?${qs}`).set(as('admin'))).status).toBe(400);
    }
    for (const who of ['ops', 'user'] as const) expect((await http().get('/v1/admin/directory/stations?country=KR').set(as(who))).status).toBe(403);
    expect((await http().get('/v1/admin/directory/stations?country=KR')).status).toBe(401);
  });

  // The smallest real files of each kind: 1 by 1 pixel.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const WEBP = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
  const JPEG = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'),
    Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]),
  ]).toString('base64');

  it('reads the kind and size of an image from its own bytes', () => {
    const png = Buffer.from(PNG, 'base64');
    expect([sniffImage(png), imageSize(png, 'image/png')]).toEqual(['image/png', { width: 1, height: 1 }]);
    const webp = Buffer.from(WEBP, 'base64');
    expect([sniffImage(webp), imageSize(webp, 'image/webp')]).toEqual(['image/webp', { width: 1, height: 1 }]);
    const jpeg = Buffer.from(JPEG, 'base64');
    expect([sniffImage(jpeg), imageSize(jpeg, 'image/jpeg')]).toEqual(['image/jpeg', { width: 3, height: 2 }]);
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(imageSize(png.subarray(0, 20), 'image/png')).toBeNull();
  });

  it('keeps a station logo only when it is on a public https host', () => {
    const logo = (favicon: unknown) => toDirectoryStation(rb(1, { favicon }))!.logoUrl;
    expect(logo(' https://cdn.example.com/a.png ')).toBe('https://cdn.example.com/a.png');
    for (const bad of ['http://cdn.example.com/a.png', 'https://192.168.1.1/a.png', 'https://localhost/a.png', 'https://printer.local/a.png', 'https://cdn.example.com:8443/a.png', 'https://u:p@cdn.example.com/a.png', '', null]) expect(logo(bad)).toBeNull();
  });

  it('lets staff upload a logo for a station and our own, serves them without sign-in, and takes them away again', async () => {
    reply = { status: 200, body: () => [rb(5000, { countrycode: 'TH' }), rb(5001, { countrycode: 'TH', favicon: '' })] };
    const map = async () => (await http().get('/v1/directory/radio/map?country=TH').expect(200)).body;
    expect(await map()).toMatchObject({ defaultLogoVersion: null, stations: [{ id: uuid(5000), customLogoVersion: null }, { id: uuid(5001), logoUrl: null, customLogoVersion: null }] });
    expect((await http().get(`/v1/directory/radio/logos/${uuid(5001)}`)).status).toBe(404);
    expect((await http().get('/v1/directory/radio/logos/default')).status).toBe(404);

    const set = await http().post(`/v1/admin/directory/logos/${uuid(5001).toUpperCase()}`).set(as('editor')).send({ image: PNG }).expect(200);
    expect(set.body).toMatchObject({ key: uuid(5001), contentType: 'image/png', bytes: Buffer.from(PNG, 'base64').length, updatedBy: 'dir-editor' });
    expect(set.body.version).toMatch(/^[0-9a-f]{16}$/);
    const own = await http().post('/v1/admin/directory/logos/default').set(as('admin')).send({ image: WEBP }).expect(200);
    // The answers are overlaid after the hour-long station cache, so a new logo shows at once.
    const after = await map();
    expect(after.defaultLogoVersion).toBe(own.body.version);
    expect(after.stations.map((s: { customLogoVersion: string | null }) => s.customLogoVersion)).toEqual([null, set.body.version]);
    expect((await http().get('/v1/directory/radio?q=logos').expect(200)).body).toMatchObject({ defaultLogoVersion: own.body.version, stations: [{}, { customLogoVersion: set.body.version }] });
    expect((await http().get('/v1/admin/directory/stations?country=TH').set(as('editor')).expect(200)).body.stations[1].customLogoVersion).toBe(set.body.version);

    const img = await http().get(`/v1/directory/radio/logos/${uuid(5001)}?v=${set.body.version}`).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(img.body, Buffer.from(PNG, 'base64'))).toBe(0);
    expect(img.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    const plain = await http().get('/v1/directory/radio/logos/default').expect(200);
    expect([plain.headers['content-type'], plain.headers['cache-control']]).toEqual(['image/webp', 'public, max-age=300']);
    await http().get('/v1/directory/radio/logos/default').set('If-None-Match', plain.headers.etag).expect(304);
    // An old version in the address is never kept for good.
    expect((await http().get('/v1/directory/radio/logos/default?v=0000000000000000').expect(200)).headers['cache-control']).toBe('public, max-age=300');

    const replaced = await http().post(`/v1/admin/directory/logos/${uuid(5001)}`).set(as('admin')).send({ image: JPEG }).expect(200);
    expect(replaced.body).toMatchObject({ contentType: 'image/jpeg', updatedBy: 'dir-admin' });
    expect(replaced.body.version).not.toBe(set.body.version);
    expect((await http().get('/v1/admin/directory/logos').set(as('editor')).expect(200)).body).toMatchObject({ default: { key: 'default', version: own.body.version, contentType: 'image/webp', updatedBy: 'dir-admin' }, stations: 1 });

    await http().post(`/v1/admin/directory/logos/${uuid(5001)}/remove`).set(as('editor')).send({}).expect(204);
    await http().post('/v1/admin/directory/logos/default/remove').set(as('editor')).send({}).expect(204);
    expect((await http().post('/v1/admin/directory/logos/default/remove').set(as('editor')).send({})).status).toBe(404);
    expect(await map()).toMatchObject({ defaultLogoVersion: null, stations: [{}, { customLogoVersion: null }] });
    expect((await http().get('/v1/admin/directory/logos').set(as('editor')).expect(200)).body).toEqual({ default: null, stations: 0 });

    const audit = await t.pool.query<{ action: string; target_id: string }>(`SELECT action, target_id FROM audit_events WHERE action LIKE 'directory.logo.%' ORDER BY id`);
    expect(audit.rows).toEqual([
      { action: 'directory.logo.set', target_id: uuid(5001) },
      { action: 'directory.logo.set', target_id: 'default' },
      { action: 'directory.logo.set', target_id: uuid(5001) },
      { action: 'directory.logo.remove', target_id: uuid(5001) },
      { action: 'directory.logo.remove', target_id: 'default' },
    ]);
  });

  it('refuses uploads that are not a small PNG, JPEG or WebP, and everyone without a catalog role', async () => {
    const post = (key: string, body: object, who: keyof typeof tokens = 'editor') => http().post(`/v1/admin/directory/logos/${key}`).set(as(who)).send(body);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    const wide = Buffer.from(PNG, 'base64');
    wide.writeUInt32BE(4000, 16);
    const cases: [string, object, string, string][] = [
      ['default', { image: svg }, 'image', 'must_be_png_jpeg_or_webp'],
      ['default', { image: 'not base64!' }, 'image', 'must_be_base64'],
      ['default', {}, 'image', 'must_be_base64'],
      ['default', { image: PNG, contentType: 'image/png' }, 'contentType', 'unknown_field'],
      ['default', { image: wide.toString('base64') }, 'image', 'dimensions_too_large'],
      ['default', { image: Buffer.from(PNG, 'base64').subarray(0, 12).toString('base64') }, 'image', 'must_be_png_jpeg_or_webp'],
      ['default', { image: Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(256 * 1024)]).toString('base64') }, 'image', 'too_large'],
      ['not-a-station', { image: PNG }, 'key', 'must_be_uuid_or_default'],
    ];
    for (const [key, body, field, reason] of cases) {
      const res = await post(key, body);
      expect([res.status, res.body.details?.field, res.body.details?.reason]).toEqual([400, field, reason]);
    }
    // Past the route's own body limit the upload is refused before it is read as JSON.
    expect((await post('default', { image: 'A'.repeat(400 * 1024) })).status).toBe(413);
    expect((await http().get('/v1/directory/radio/logos/nope')).status).toBe(400);
    expect((await http().get('/v1/directory/radio/logos/default?size=2')).status).toBe(400);
    for (const who of ['ops', 'user'] as const) {
      expect((await post('default', { image: PNG }, who)).status).toBe(403);
      expect((await http().post('/v1/admin/directory/logos/default/remove').set(as(who)).send({})).status).toBe(403);
      expect((await http().get('/v1/admin/directory/logos').set(as(who))).status).toBe(403);
    }
    expect((await http().post('/v1/admin/directory/logos/default').send({ image: PNG })).status).toBe(401);
    expect((await http().get('/v1/directory/radio/logos/default')).status).toBe(404);
  });
});
