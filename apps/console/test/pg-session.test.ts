import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgSessionStore } from '@/lib/pg-session';

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/postgres';
const SECRET = 's'.repeat(32);
const tokens = { accessToken: 'access-SECRET-123', refreshToken: 'refresh-SECRET-456', expiresAt: 1 };

describe('PgSessionStore', () => {
  const name = `tunedeck_console_sessions_${randomBytes(5).toString('hex')}`;
  let pool: Pool;
  let now = 1_000_000;
  const store = (secret = SECRET) => new PgSessionStore(pool, secret, 100, 250, () => now, { idleMs: 30, absoluteMs: 120 });

  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.toString() });
  });
  afterAll(async () => {
    await pool.end();
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it('is shared between instances and creates its own table', async () => {
    const { id, session } = await store().create(tokens);
    const other = await store().touch(id);
    expect(other).toMatchObject({ csrfToken: session.csrfToken, tokens, createdAt: now, lastSeenAt: now });
    await store().delete(id);
    expect(await store().touch(id)).toBeNull();
  });

  it('expires on idle and absolute lifetime like the memory store', async () => {
    const s = store();
    const { id } = await s.create(tokens);
    now += 90;
    expect(await s.touch(id)).not.toBeNull();
    now += 90;
    expect(await s.touch(id)).not.toBeNull();
    now += 80; // 260 since creation, past the 250 absolute limit
    expect(await s.touch(id)).toBeNull();
    const { id: idle } = await s.create(tokens);
    now += 101;
    expect(await s.touch(idle)).toBeNull();
  });

  it('switches to the shorter staff limits once marked staff', async () => {
    const s = store();
    const { id } = await s.create(tokens);
    const session = (await s.touch(id))!;
    await s.update(id, { ...session, staff: true });
    now += 31;
    expect(await s.touch(id)).toBeNull();
  });

  it('keeps tokens encrypted at rest and never stores the session id', async () => {
    const { id, session } = await store().create(tokens);
    const dump = JSON.stringify((await pool.query('SELECT key, encode(payload, $1) AS p FROM console_sessions', ['escape'])).rows);
    for (const secret of ['access-SECRET-123', 'refresh-SECRET-456', session.csrfToken, id]) expect(dump).not.toContain(secret);
  });

  it('rejects a payload moved to another session or read with another secret', async () => {
    const a = await store().create(tokens);
    const b = await store().create({ ...tokens, accessToken: 'other' });
    await pool.query(
      `UPDATE console_sessions SET payload = (SELECT payload FROM console_sessions WHERE key = encode(sha256($1::bytea), 'hex'))
        WHERE key = encode(sha256($2::bytea), 'hex')`,
      [a.id, b.id],
    );
    expect(await store().touch(b.id)).toBeNull();
    expect(await store('t'.repeat(32)).touch(a.id)).toBeNull();
    expect(await store().touch(a.id)).toBeNull(); // the failed read with the wrong secret removed it
  });
});
