import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CheckerModule } from '../src/checker';
import { createPool, Database } from '../src/db/database';
import { runStaffCli } from '../src/staff/staff-cli';
import { StationHealthService } from '../src/stations/station-health';
import { FetchedHead, ProbeDeps } from '../src/stations/stream-probe';
import { createIdentity, createTestApp, createTestDatabase, testConfig, TestIdentity } from './harness';

const station = {
  name: 'Worker FM',
  country: 'TH',
  language: 'th',
  genres: ['news'],
  streamUrl: 'https://good.example.com/live.mp3',
  codec: 'mp3',
  bitrateKbps: 128,
};
const rights = { holder: 'Worker Media', basis: 'owner_permission', reference: 'CONTRACT-1', territories: ['TH'] };
const up: FetchedHead = { status: 200, headers: { 'content-type': 'audio/mpeg' }, body: Buffer.from('ID3') };

/** Doc 17: with STATION_CHECK_RUNNER=worker only the checker process touches the network. */
describe('stream checks in a separate checker process', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let worker: INestApplicationContext;
  let workerPool: ReturnType<typeof createPool>;
  let tokens: Record<'editor' | 'admin', string>;
  const apiFetched: string[] = [];
  const workerFetched: string[] = [];
  const fake = (log: string[]): ProbeDeps => ({
    resolve: async () => ['93.184.216.34'],
    fetchFrom: async (address, url) => {
      log.push(url.hostname);
      return up;
    },
  });
  const http = () => request(t.app.getHttpServer());
  const as = (who: keyof typeof tokens) => ({ Authorization: `Bearer ${tokens[who]}` });
  const staff = (...args: string[]) => runStaffCli(args, new Database(t.pool), () => undefined);
  const checker = () => worker.get(StationHealthService);

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    const stationCheck = { enabled: true, intervalMinutes: 15, region: 'worker-region', runner: 'worker' as const };
    t = await createTestApp(db.url, id.keyResolver, { probeDeps: fake(apiFetched), config: { stationCheck } });
    workerPool = createPool(db.url);
    const ref = await Test.createTestingModule({
      imports: [CheckerModule.forRoot({ config: { ...testConfig(db.url), stationCheck }, pool: workerPool, logWriter: () => undefined, probeDeps: fake(workerFetched) })],
    }).compile();
    worker = await ref.init();
    tokens = { editor: await id.token('w-editor'), admin: await id.token('w-admin') };
    await staff('grant', 'w-editor', 'catalog_editor', '--by', 'tar', '--reason', 't');
    await staff('grant', 'w-admin', 'admin', '--by', 'tar', '--reason', 't');
  });
  afterAll(async () => {
    await worker.close();
    await workerPool.end();
    await t.close();
    await db.drop();
  });

  it('runs "check now" in the checker, and the API never probes', async () => {
    const sid = (await http().post('/v1/admin/stations').set(as('editor')).send(station).expect(201)).body.id;
    await http().post(`/v1/admin/stations/${sid}/rights`).set(as('editor')).send(rights).expect(201);
    // Stand in for the checker's one-second loop while the API waits.
    const serving = setInterval(() => void checker().serveRequests(), 100);
    try {
      const res = await http().post(`/v1/admin/stations/${sid}/check`).set(as('editor')).send({}).expect(200);
      expect(res.body).toMatchObject({ target: 'draft', ok: true, reason: 'ok', httpStatus: 200 });
    } finally {
      clearInterval(serving);
    }
    expect(workerFetched).toEqual(['good.example.com']);
    expect(apiFetched).toEqual([]);
    const { rows } = await t.pool.query(`SELECT target, status, check_region FROM station_health WHERE station_id = $1`, [sid]);
    expect(rows).toEqual([{ target: 'draft', status: 'ok', check_region: 'worker-region' }]);
    const audit = await t.pool.query(`SELECT changes FROM audit_events WHERE action = 'station.check' AND target_id = $1`, [sid]);
    expect(audit.rows).toEqual([{ changes: { target: 'draft', result: 'ok' } }]);
  });

  it('scheduled passes run in the checker, not the API', async () => {
    apiFetched.length = 0;
    workerFetched.length = 0;
    const sid = (await http().post('/v1/admin/stations').set(as('editor')).send({ ...station, streamUrl: 'https://pub.example.com/x' }).expect(201)).body.id;
    await http().post(`/v1/admin/stations/${sid}/rights`).set(as('editor')).send(rights).expect(201);
    await http().post(`/v1/admin/stations/${sid}/publish`).set(as('admin')).set('If-Match', '"1"').send({ reason: 'reviewed' }).expect(200);
    expect(await checker().runOnce()).toBeGreaterThanOrEqual(1);
    expect(workerFetched).toContain('pub.example.com');
    expect(apiFetched).toEqual([]);
  });

  it('answers 503 when no checker takes the request, and withdraws it', async () => {
    const sid = (await http().post('/v1/admin/stations').set(as('editor')).send({ ...station, streamUrl: 'https://late.example.com/x' }).expect(201)).body.id;
    // Nobody serves requests here, so the API gives up after its 15-second wait.
    const res = await http().post(`/v1/admin/stations/${sid}/check`).set(as('editor')).send({});
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('CHECKER_UNAVAILABLE');
    const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM station_check_requests WHERE station_id = $1`, [sid]);
    expect(rows[0].n).toBe(0);
  }, 30_000);
});
