import request from 'supertest';
import { Database } from '../src/db/database';
import { readFavicon, sniffImage } from '../src/directory/logos';
import type { FetchedHead, ProbeDeps } from '../src/stations/stream-probe';
import { runStaffCli } from '../src/staff/staff-cli';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

const BASE = 'https://rb.example.test';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const PNG2 = Buffer.concat([PNG, Buffer.alloc(10, 9)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const rb = (n: number, over: Record<string, unknown> = {}) => ({
  stationuuid: uuid(n),
  name: `Station ${n}`,
  url: `https://stream${n}.example.com/live`,
  url_resolved: `https://stream${n}.example.com/live.mp3`,
  homepage: `https://station${n}.example.com/`,
  favicon: `https://station${n}.example.com/logo.png`,
  tags: 'jazz',
  countrycode: 'NZ',
  language: 'english',
  codec: 'MP3',
  bitrate: 128,
  hls: 0,
  lastcheckok: 1,
  geo_lat: -41.2,
  geo_long: 174.7,
  ...over,
});

/** Fake DNS and HTTPS for favicons: host name → addresses, URL → answer. */
function fakeNet(sites: Record<string, Partial<FetchedHead>>, dns: Record<string, string[]> = {}) {
  const asked: string[] = [];
  const net: ProbeDeps = {
    resolve: async (host) => dns[host] ?? ['93.184.216.34'],
    fetchFrom: async (_address, url) => {
      asked.push(url.href);
      const site = sites[url.href];
      if (!site) return { status: 404, headers: {}, body: Buffer.alloc(0) };
      return { status: 200, headers: {}, body: Buffer.alloc(0), ...site };
    },
  };
  return { net, asked };
}

describe('sniffImage and readFavicon', () => {
  it('knows images by their first bytes, never SVG', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImage(Buffer.from([0, 0, 1, 0, 1, 0]))).toBe('image/x-icon');
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(Buffer.from('<html>'))).toBeNull();
  });

  it('follows a few redirects to public https addresses only, and refuses big or non-image answers', async () => {
    const { net } = fakeNet({
      'https://a.example.com/f.ico': { status: 301, headers: { location: 'https://cdn.example.com/f.png' } },
      'https://cdn.example.com/f.png': { body: PNG },
      'https://b.example.com/f.png': { status: 302, headers: { location: 'https://inside.example.com/f.png' } },
      'https://inside.example.com/f.png': { body: PNG },
      'https://c.example.com/f.svg': { body: SVG },
      'https://d.example.com/big.png': { body: Buffer.concat([PNG, Buffer.alloc(64 * 1024)]) },
      'https://e.example.com/f.png': { status: 302, headers: { location: 'http://e.example.com/f.png' } },
    }, { 'inside.example.com': ['10.0.0.5'] });
    expect(await readFavicon('https://a.example.com/f.ico', net)).toEqual({ contentType: 'image/png', data: PNG });
    expect(await readFavicon('https://b.example.com/f.png', net)).toBeNull();
    expect(await readFavicon('https://c.example.com/f.svg', net)).toBeNull();
    expect(await readFavicon('https://d.example.com/big.png', net)).toBeNull();
    expect(await readFavicon('https://e.example.com/f.png', net)).toBeNull();
    expect(await readFavicon('https://127.0.0.1/f.png', net)).toBeNull();
    expect(await readFavicon('https://a.example.com:8443/f.png', net)).toBeNull();
    expect(await readFavicon('not a url', net)).toBeNull();
  });
});

describe('station logos', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let tokens: Record<'editor' | 'admin' | 'ops' | 'user', string>;
  const http = () => request(t.app.getHttpServer());
  const as = (who: keyof typeof tokens) => ({ Authorization: `Bearer ${tokens[who]}` });
  const staff = (...args: string[]) => runStaffCli(args, new Database(t.pool), () => undefined);
  const sites = fakeNet({ 'https://station1.example.com/logo.png': { body: JPEG }, 'https://station3.example.com/logo.png': { body: SVG } });
  const upload = (data: Buffer, contentType = 'image/png') => ({ contentType, data: data.toString('base64') });

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver, {
      config: { radioDirectory: { baseUrl: BASE } },
      directoryFetch: async (url) => {
        const u = new URL(url);
        const body = u.searchParams.get('countrycode') === 'NZ' ? [rb(1), rb(2), rb(3), rb(4, { favicon: '' })] : [];
        return { status: 200, text: async () => JSON.stringify(body) };
      },
      logoFetch: sites.net,
    });
    tokens = { editor: await id.token('logo-editor'), admin: await id.token('logo-admin'), ops: await id.token('logo-ops'), user: await id.token('logo-user') };
    expect(await staff('grant', 'logo-editor', 'catalog_editor', '--by', 'tar', '--reason', 'catalog team')).toBe(0);
    expect(await staff('grant', 'logo-admin', 'admin', '--by', 'tar', '--reason', 'reviewer')).toBe(0);
    expect(await staff('grant', 'logo-ops', 'operator', '--by', 'tar', '--reason', 'ops')).toBe(0);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('serves the uploaded logo, else the favicon read through our server, else nothing', async () => {
    // Logos are found among the stations the map lists already hold.
    expect((await http().get(`/v1/directory/radio/stations/${uuid(1)}/logo`)).status).toBe(404);
    const map = (await http().get('/v1/directory/radio/map?country=NZ').expect(200)).body.stations as { id: string; logoVersion?: string }[];
    const rbVersion = map[0].logoVersion;
    expect(rbVersion).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(map.find((s) => s.id === uuid(4))!.logoVersion).toBeUndefined();

    const fav = await http().get(`/v1/directory/radio/stations/${uuid(1)}/logo?v=${rbVersion}`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(fav.status).toBe(200);
    expect(fav.headers['content-type']).toBe('image/jpeg');
    expect(fav.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(fav.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(fav.body as Buffer, JPEG)).toBe(0);
    // Read once, then kept.
    await http().get(`/v1/directory/radio/stations/${uuid(1)}/logo`).expect(200);
    expect(sites.asked.filter((u) => u.includes('station1')).length).toBe(1);
    // An SVG favicon, or none at all, is no logo.
    expect((await http().get(`/v1/directory/radio/stations/${uuid(3)}/logo`)).status).toBe(404);
    expect((await http().get(`/v1/directory/radio/stations/${uuid(4)}/logo`)).status).toBe(404);
    expect((await http().get(`/v1/directory/radio/stations/${uuid(2)}/logo?x=1`)).status).toBe(400);

    // Staff upload one: it wins, and the map's version changes.
    const set = await http().post(`/v1/admin/directory/stations/${uuid(3).toUpperCase()}/logo`).set(as('editor')).send(upload(PNG));
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ stationId: uuid(3), version: expect.stringMatching(/^[A-Za-z0-9_-]{12}$/) });
    const logo = await http().get(`/v1/directory/radio/stations/${uuid(3)}/logo`).expect(200);
    expect(logo.headers['content-type']).toBe('image/png');
    const after = (await http().get('/v1/directory/radio/map?country=NZ').expect(200)).body.stations as { id: string; logoVersion?: string }[];
    expect(after.find((s) => s.id === uuid(3))!.logoVersion).toBe(set.body.version);
    const list = (await http().get('/v1/admin/directory/stations?country=NZ').set(as('editor')).expect(200)).body.stations as { logoSource: string | null }[];
    expect(list.map((s) => s.logoSource)).toEqual(['radio-browser', 'radio-browser', 'staff', null]);

    await http().post(`/v1/admin/directory/stations/${uuid(3)}/logo`).set(as('admin')).send(upload(PNG2)).expect(200);
    await http().post(`/v1/admin/directory/stations/${uuid(3)}/logo/remove`).set(as('editor')).send({}).expect(204);
    expect((await http().post(`/v1/admin/directory/stations/${uuid(3)}/logo/remove`).set(as('editor')).send({})).status).toBe(404);
    expect((await http().get(`/v1/directory/radio/stations/${uuid(3)}/logo`)).status).toBe(404);

    const audit = await t.pool.query<{ action: string; changes: Record<string, unknown> }>(`SELECT action, changes FROM audit_events WHERE action LIKE 'directory.logo.%' ORDER BY id`);
    expect(audit.rows.map((r) => [r.action, r.changes.bytes ?? null, 'before' in r.changes])).toEqual([
      ['directory.logo.set', PNG.length, false],
      ['directory.logo.set', PNG2.length, true],
      ['directory.logo.remove', null, true],
    ]);
  });

  it('refuses uploads that are not a small PNG, JPEG or WebP of the stated type', async () => {
    const url = `/v1/admin/directory/stations/${uuid(2)}/logo`;
    for (const body of [
      upload(SVG, 'image/svg+xml'),
      upload(SVG),
      upload(JPEG, 'image/png'),
      upload(Buffer.concat([PNG, Buffer.alloc(64 * 1024)])),
      { contentType: 'image/png', data: 'not base64!' },
      { ...upload(PNG), name: 'x.png' },
      {},
    ]) {
      expect((await http().post(url).set(as('admin')).send(body)).status).toBe(400);
    }
    expect((await http().post('/v1/admin/directory/stations/nope/logo').set(as('admin')).send(upload(PNG))).status).toBe(400);
    for (const who of ['ops', 'user'] as const) expect((await http().post(url).set(as(who)).send(upload(PNG))).status).toBe(403);
    expect((await http().post(url).send(upload(PNG))).status).toBe(401);
  });

  it('lets admins replace TuneDeck’s own logo, shown for stations with none', async () => {
    expect((await http().get('/v1/brand/station-logo')).status).toBe(404);
    expect((await http().get('/v1/admin/brand/station-logo').set(as('admin')).expect(200)).body).toEqual({ custom: false });
    // Catalog editors change station logos, not the company's.
    expect((await http().post('/v1/admin/brand/station-logo').set(as('editor')).send(upload(PNG))).status).toBe(403);
    const set = await http().post('/v1/admin/brand/station-logo').set(as('admin')).send(upload(JPEG, 'image/jpeg')).expect(200);
    const brand = await http().get('/v1/brand/station-logo').expect(200);
    expect(brand.headers['content-type']).toBe('image/jpeg');
    expect(brand.headers['cache-control']).toBe('public, max-age=3600');
    expect((await http().get('/v1/admin/brand/station-logo').set(as('admin')).expect(200)).body).toEqual({ custom: true, version: set.body.version, updatedAt: expect.any(String) });
    await http().post('/v1/admin/brand/station-logo/remove').set(as('admin')).send({}).expect(204);
    expect((await http().get('/v1/brand/station-logo')).status).toBe(404);
    const audit = await t.pool.query<{ action: string }>(`SELECT action FROM audit_events WHERE action LIKE 'brand.logo.%' ORDER BY id`);
    expect(audit.rows.map((r) => r.action)).toEqual(['brand.logo.set', 'brand.logo.remove']);
  });
});
