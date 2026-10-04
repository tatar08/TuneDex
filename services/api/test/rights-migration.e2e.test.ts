import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { migrate } from '../src/db/migrate';

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/postgres';
const MIGRATIONS = join(__dirname, '../src/db/migrations');

/** Migration 024 moves the inline draft rights fields into rights_records. */
describe('rights records migration (024)', () => {
  const name = `tunedeck_test_${randomBytes(6).toString('hex')}`;
  let pool: Pool;
  let before: string;

  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.toString() });
    // Everything before 024, as a database that has not taken it yet.
    before = mkdtempSync(join(tmpdir(), 'td-mig-'));
    for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f < '024')) copyFileSync(join(MIGRATIONS, f), join(before, f));
    await migrate(pool, before);
  });
  afterAll(async () => {
    await pool.end();
    rmSync(before, { recursive: true, force: true });
    const c = new Client({ connectionString: ADMIN_URL });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await c.end();
  });

  it('back-fills one record per station with rights, then drops the inline fields', async () => {
    const [{ id: user }] = (await pool.query(`INSERT INTO users (oidc_subject) VALUES ('editor') RETURNING id`)).rows;
    const draft = (o: object) => JSON.stringify({ name: 'X', country: 'TH', language: 'th', genres: [], streamUrl: 'https://s.example.com/a', codec: 'mp3', bitrateKbps: null, ...o });
    const insert = async (d: string, published: string | null, rightsEnd: string | null = null) =>
      (
        await pool.query(
          `INSERT INTO radio_stations (draft, created_by, updated_by, published, published_revision, published_by, published_at, rights_expires_at, created_at)
           VALUES ($1, $2, $2, $3, CASE WHEN $3::jsonb IS NULL THEN NULL ELSE 1 END, CASE WHEN $3::jsonb IS NULL THEN NULL ELSE $2::uuid END,
                   CASE WHEN $3::jsonb IS NULL THEN NULL ELSE now() END, $4, '2026-03-01T10:00:00Z') RETURNING id`,
          [d, user, published, rightsEnd],
        )
      ).rows[0].id as string;

    const rights = { rightsBasis: 'owner_permission', rightsReference: 'CONTRACT-1', rightsExpiresAt: '2099-12-31' };
    const live = await insert(draft(rights), draft(rights), '2099-12-31T23:59:59.999Z');
    const noRights = await insert(draft({ rightsBasis: null, rightsReference: null, rightsExpiresAt: null }), null);
    // Draft rights cleared after publishing, and the draft moved country: the published snapshot's rights count.
    const cleared = await insert(draft({ country: 'LA', rightsBasis: null, rightsReference: null, rightsExpiresAt: null }), draft({ ...rights, rightsExpiresAt: null }));
    const expired = await insert(draft({ ...rights, rightsExpiresAt: '2020-01-01' }), draft({ ...rights, rightsExpiresAt: '2020-01-01' }), '2020-01-01T23:59:59.999Z');

    expect(await migrate(pool, MIGRATIONS)).toContain('024_rights_records.sql');

    const records = (
      await pool.query(
        `SELECT station_id, holder, basis, reference, territories, valid_from::text, expires_at::text, status, evidence_refs, created_by
           FROM rights_records ORDER BY station_id`,
      )
    ).rows;
    const of = (sid: string) => records.filter((r) => r.station_id === sid);
    expect(records).toHaveLength(3);
    expect(of(noRights)).toEqual([]);
    expect(of(live)).toEqual([
      {
        station_id: live,
        holder: '[not recorded: migrated]',
        basis: 'owner_permission',
        reference: 'CONTRACT-1',
        territories: ['TH'],
        valid_from: '2026-03-01',
        expires_at: '2099-12-31',
        status: 'active',
        evidence_refs: [],
        created_by: null,
      },
    ]);
    expect(of(cleared)[0]).toMatchObject({ territories: ['LA', 'TH'], expires_at: null });
    expect(of(expired)[0]).toMatchObject({ valid_from: '2020-01-01', expires_at: '2020-01-01' });

    const stations = (await pool.query(`SELECT id, draft, published, revision, rights_expires_at, rights_expires_at > now() AS live FROM radio_stations`)).rows;
    for (const s of stations) {
      for (const k of ['rightsBasis', 'rightsReference', 'rightsExpiresAt']) {
        expect(s.draft).not.toHaveProperty(k);
        if (s.published) expect(s.published).not.toHaveProperty(k);
      }
      expect(Number(s.revision)).toBe(1);
    }
    const st = (sid: string) => stations.find((s) => s.id === sid)!;
    expect(st(live).rights_expires_at.toISOString()).toBe('2099-12-31T23:59:59.999Z');
    expect(st(cleared).rights_expires_at).toBeNull();
    expect(st(expired).live).toBe(false);
    expect(st(live).draft).toMatchObject({ name: 'X', country: 'TH' });
  });
});
