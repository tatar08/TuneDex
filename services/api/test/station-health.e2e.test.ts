import request from 'supertest';
import { Database } from '../src/db/database';
import { runStaffCli } from '../src/staff/staff-cli';
import { StationHealthService } from '../src/stations/station-health';
import { FetchedHead, ProbeDeps } from '../src/stations/stream-probe';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

const station = {
  name: 'Health FM',
  country: 'TH',
  language: 'th',
  genres: ['news'],
  streamUrl: 'https://good.example.com/live.mp3',
  codec: 'mp3',
  bitrateKbps: 128,
};
const rights = { holder: 'Health Media', basis: 'owner_permission', reference: 'CONTRACT-1', territories: ['TH'] };

describe('stream health checks', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let tokens: Record<'editor' | 'admin' | 'auditor' | 'user', string>;
  /** host → what the fake network answers; flip entries to simulate an outage. */
  const network: Record<string, { addresses: string[]; page?: FetchedHead }> = {};
  const fetched: string[] = [];
  const probeDeps: ProbeDeps = {
    resolve: async (host) => {
      const n = network[host];
      if (!n) throw new Error('ENOTFOUND');
      return n.addresses;
    },
    fetchFrom: async (address, url) => {
      fetched.push(`${address} ${url.hostname}`);
      const page = network[url.hostname]?.page;
      if (!page) throw new Error('ECONNREFUSED');
      return page;
    },
  };
  const up: FetchedHead = { status: 200, headers: { 'content-type': 'audio/mpeg' }, body: Buffer.from('ID3') };
  const http = () => request(t.app.getHttpServer());
  const as = (who: keyof typeof tokens) => ({ Authorization: `Bearer ${tokens[who]}` });
  const staff = (...args: string[]) => runStaffCli(args, new Database(t.pool), () => undefined);
  const checker = () => t.app.get(StationHealthService);
  const view = async (sid: string) => (await http().get(`/v1/admin/stations/${sid}`).set(as('editor')).expect(200)).body;

  async function published(body: object = station): Promise<string> {
    const sid = (await http().post('/v1/admin/stations').set(as('editor')).send(body).expect(201)).body.id;
    await http().post(`/v1/admin/stations/${sid}/rights`).set(as('editor')).send(rights).expect(201);
    await http().post(`/v1/admin/stations/${sid}/publish`).set(as('admin')).set('If-Match', '"1"').send({ reason: 'reviewed' }).expect(200);
    // Publishing resets health; back-date it so checks in this test count.
    await t.pool.query(`UPDATE radio_stations SET published_at = now() - interval '1 hour' WHERE id = $1`, [sid]);
    return sid;
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver, { probeDeps });
    tokens = {
      editor: await id.token('h-editor'),
      admin: await id.token('h-admin'),
      auditor: await id.token('h-auditor'),
      user: await id.token('h-user'),
    };
    await staff('grant', 'h-editor', 'catalog_editor', '--by', 'tar', '--reason', 't');
    await staff('grant', 'h-admin', 'admin', '--by', 'tar', '--reason', 't');
    await staff('grant', 'h-auditor', 'auditor', '--by', 'tar', '--reason', 't');
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });
  beforeEach(() => {
    for (const k of Object.keys(network)) delete network[k];
    network['good.example.com'] = { addresses: ['93.184.216.34'], page: up };
    fetched.length = 0;
  });

  it('starts unknown, then shows ok after a scheduled pass', async () => {
    const sid = await published();
    expect((await view(sid)).health).toEqual({ state: 'unknown', regions: [] });
    expect(await checker().runOnce()).toBeGreaterThanOrEqual(1);
    const { health } = await view(sid);
    expect(health.state).toBe('ok');
    expect(health.regions).toEqual([expect.objectContaining({ region: 'test-region', state: 'ok', reason: 'ok', httpStatus: 200, consecutiveFailures: 0 })]);
    const list = (await http().get('/v1/admin/stations').set(as('editor')).expect(200)).body.stations;
    expect(list.find((s: { id: string }) => s.id === sid).health.state).toBe('ok');
  });

  it('marks a station suspect after three failures in a row, never disables it, and recovers on the next success', async () => {
    const sid = await published({ ...station, streamUrl: 'https://flaky.example.com/live' });
    network['flaky.example.com'] = { addresses: ['93.184.216.34'], page: { status: 503, headers: {}, body: Buffer.alloc(0) } };
    await checker().runOnce();
    expect((await view(sid)).health).toMatchObject({ state: 'failing', regions: [{ consecutiveFailures: 1, reason: 'http_status', httpStatus: 503 }] });
    await checker().runOnce();
    await checker().runOnce();
    const after = await view(sid);
    expect(after.health).toMatchObject({ state: 'suspect', regions: [{ consecutiveFailures: 3 }] });
    expect(after.status).toBe('published');
    expect((await http().get('/v1/catalog/radio').expect(200)).body.stations.map((s: { id: string }) => s.id)).toContain(sid);

    network['flaky.example.com'].page = up;
    await checker().runOnce();
    expect((await view(sid)).health.state).toBe('ok');
  });

  it('checks published variants too, without letting a broken one change the station state', async () => {
    const sid = await published({
      ...station,
      streamUrl: 'https://good.example.com/main.mp3',
      variants: [
        { streamUrl: 'https://good.example.com/low.mp3', codec: 'mp3', bitrateKbps: 48 },
        { streamUrl: 'https://gone.example.com/low.aac', codec: 'aac', bitrateKbps: 32 },
      ],
    });
    await checker().runOnce();
    const { health } = await view(sid);
    expect(health).toMatchObject({ state: 'ok', failingVariants: [2] });
    const history = (await http().get(`/v1/admin/stations/${sid}/health`).set(as('editor')).expect(200)).body.checks;
    expect(history.map((c: { variant: number; ok: boolean }) => [c.variant, c.ok]).sort()).toEqual([
      [0, true],
      [1, true],
      [2, false],
    ]);
    network['gone.example.com'] = { addresses: ['93.184.216.34'], page: up };
    await checker().runOnce();
    expect((await view(sid)).health.failingVariants).toBeUndefined();
  });

  it('never connects to a private address and stores no URL', async () => {
    const sid = await published({ ...station, streamUrl: 'https://rebind.example.com/secret-token-abc/live' });
    network['rebind.example.com'] = { addresses: ['10.0.0.5'], page: up };
    await checker().runOnce();
    expect(fetched.some((f) => f.endsWith('rebind.example.com'))).toBe(false);
    expect((await view(sid)).health.regions[0].reason).toBe('blocked_address');
    const dump = JSON.stringify((await t.pool.query('SELECT * FROM station_health')).rows);
    expect(dump).not.toContain('rebind.example.com');
    expect(dump).not.toContain('secret-token-abc');
    expect(t.logs.raw()).not.toContain('secret-token-abc');
  });

  it('skips drafts and disabled stations in the scheduled pass', async () => {
    const draft = (await http().post('/v1/admin/stations').set(as('editor')).send({ ...station, streamUrl: 'https://draft.example.com/x' }).expect(201)).body.id;
    const off = await published({ ...station, streamUrl: 'https://off.example.com/x' });
    await http().post(`/v1/admin/stations/${off}/disable`).set(as('admin')).send({ reason: 'test' }).expect(200);
    network['draft.example.com'] = { addresses: ['93.184.216.34'], page: up };
    network['off.example.com'] = { addresses: ['93.184.216.34'], page: up };
    await checker().runOnce();
    expect(fetched.filter((f) => f.includes('draft.example.com') || f.includes('off.example.com'))).toEqual([]);
    expect((await view(draft)).health.state).toBe('unknown');
  });

  it('only counts checks made since the last publish', async () => {
    const sid = await published({ ...station, streamUrl: 'https://moved.example.com/live' });
    await checker().runOnce();
    await checker().runOnce();
    await checker().runOnce();
    expect((await view(sid)).health.state).toBe('suspect');
    await http().patch(`/v1/admin/stations/${sid}`).set(as('editor')).set('If-Match', '"1"').send({ streamUrl: 'https://good.example.com/new' }).expect(200);
    await http().post(`/v1/admin/stations/${sid}/publish`).set(as('admin')).set('If-Match', '"2"').send({ reason: 'new url' }).expect(200);
    expect((await view(sid)).health.state).toBe('unknown');
  });

  it('lets staff check now, at most once a minute, and audits it', async () => {
    const sid = await published();
    await checker().runOnce(); // a scheduled check just now does not count against the manual limit
    const res = await http().post(`/v1/admin/stations/${sid}/check`).set(as('editor')).expect(200);
    expect(res.body).toMatchObject({ target: 'published', ok: true, reason: 'ok', region: 'test-region' });
    const again = await http().post(`/v1/admin/stations/${sid}/check`).set(as('editor'));
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('CHECK_TOO_SOON');
    // The wait left, in the body and the standard header.
    const wait = again.body.details.retryAfterSeconds;
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
    expect(again.headers['retry-after']).toBe(String(wait));
    const audit = await t.pool.query(`SELECT actor, changes FROM audit_events WHERE action = 'station.check' AND target_id = $1`, [sid]);
    expect(audit.rows).toEqual([{ actor: expect.stringMatching(/^user:/), changes: { target: 'published', result: 'ok' } }]);
  });

  it('checks the draft stream before the first publish without changing health', async () => {
    const sid = (await http().post('/v1/admin/stations').set(as('editor')).send(station).expect(201)).body.id;
    const res = await http().post(`/v1/admin/stations/${sid}/check`).set(as('editor')).expect(200);
    expect(res.body.target).toBe('draft');
    expect((await view(sid)).health.state).toBe('unknown');
    const history = (await http().get(`/v1/admin/stations/${sid}/health`).set(as('editor')).expect(200)).body.checks;
    expect(history).toEqual([expect.objectContaining({ target: 'draft', ok: true, reason: 'ok', region: 'test-region' })]);
    await http().get('/v1/admin/stations/7c2e9d10-3b4a-4f5e-8a6b-9c0d1e2f3a4b/health').set(as('editor')).expect(404);
  });

  it('keeps health routes to catalog staff', async () => {
    const sid = await published();
    expect((await http().post(`/v1/admin/stations/${sid}/check`)).status).toBe(401);
    for (const who of ['user', 'auditor'] as const) {
      expect((await http().post(`/v1/admin/stations/${sid}/check`).set(as(who))).status).toBe(403);
      expect((await http().get(`/v1/admin/stations/${sid}/health`).set(as(who))).status).toBe(403);
    }
    expect((await http().post('/v1/admin/stations/not-a-uuid/check').set(as('editor'))).status).toBe(400);
    expect((await http().post('/v1/admin/stations/0b9a4f8e-6c1d-4e2a-9f3b-1a2b3c4d5e6f/check').set(as('editor'))).status).toBe(404);
  });

  it('lets only one pass run at a time across instances', async () => {
    const holder = await t.pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(7421017)');
      expect(await checker().runOnce()).toBe(0);
    } finally {
      await holder.query('SELECT pg_advisory_unlock(7421017)');
      holder.release();
    }
    expect(await checker().runOnce()).toBeGreaterThan(0);
  });
});
