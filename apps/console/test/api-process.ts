import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { API_AUDIENCE } from './mock-idp';

const API_DIR = join(__dirname, '../../../services/api');
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/postgres';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

async function psql(url: string, sql: string) {
  // Reuse services/api's pg driver rather than adding a database dependency to the console.
  const { Client } = createRequire(join(API_DIR, 'package.json'))('pg');
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(sql);
  } finally {
    await c.end();
  }
}

export interface ApiProcess {
  url: string;
  stop: () => Promise<void>;
  /** Runs the operator staff CLI (grant/revoke/list) against this API's database. */
  staff: (...args: string[]) => void;
  /** Runs SQL against this API's database (tests seed rows the API only writes on a schedule). */
  sql: (query: string) => Promise<unknown>;
}

/**
 * Runs the real services/api build against a throwaway PostgreSQL database,
 * trusting the mock IdP's JWKS. Requires `npm ci && npm run build` in services/api.
 */
export async function startApi(issuer: string): Promise<ApiProcess> {
  if (!existsSync(join(API_DIR, 'dist/main.js'))) {
    throw new Error('services/api is not built: run `npm ci && npm run build` in services/api first');
  }
  const db = `tunedeck_console_${randomBytes(5).toString('hex')}`;
  await psql(ADMIN_URL, `CREATE DATABASE ${db}`);
  const dbUrl = new URL(ADMIN_URL);
  dbUrl.pathname = `/${db}`;
  const port = await freePort();
  const env = {
    ...process.env,
    APP_ENV: 'dev',
    BUILD_VERSION: 'console-test',
    PORT: String(port),
    DATABASE_URL: dbUrl.toString(),
    OIDC_ISSUER: issuer,
    OIDC_AUDIENCE: API_AUDIENCE,
    OIDC_JWKS_URI: `${issuer}/jwks`,
  };
  execFileSync('node', ['dist/db/migrate.js'], { cwd: API_DIR, env, stdio: 'ignore' });
  const child: ChildProcess = spawn('node', ['dist/main.js'], { cwd: API_DIR, env, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/health/ready`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    sql: (query) => psql(dbUrl.toString(), query),
    staff: (...args) => {
      execFileSync('node', ['dist/staff/staff-cli.js', ...args], { cwd: API_DIR, env, stdio: 'ignore' });
    },
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
      await psql(ADMIN_URL, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    },
  };
}
