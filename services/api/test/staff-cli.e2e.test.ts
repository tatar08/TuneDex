import { Pool } from 'pg';
import { IdpUsersService } from '../src/account/idp-users';
import { AppConfig } from '../src/config';
import { Database } from '../src/db/database';
import { runStaffCli } from '../src/staff/staff-cli';
import { createTestDatabase } from './harness';

describe('staff-cli grant needs a one-time code at Keycloak', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool;
  const lines: string[] = [];
  const run = (otp: ((s: string) => Promise<boolean>) | undefined, ...args: string[]) => runStaffCli(args, new Database(pool), (l) => lines.push(l), otp);

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.url });
  });
  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it('refuses a grant to someone without a code, grants once they have one, and never checks for a revoke', async () => {
    expect(await run(async () => false, 'grant', 'kc-new', 'admin', '--by', 'tar', '--reason', 'new reviewer')).toBe(3);
    expect(lines.pop()).toMatch(/no one-time code yet/);
    expect((await pool.query(`SELECT 1 FROM staff_roles`)).rows).toEqual([]);
    expect(await run(async () => true, 'grant', 'kc-new', 'admin', '--by', 'tar', '--reason', 'new reviewer')).toBe(0);
    const never = async () => {
      throw new Error('not asked');
    };
    expect(await run(never, 'revoke', 'kc-new', 'admin', '--by', 'tar', '--reason', 'left the team')).toBe(0);
  });

  it('warns but grants where Keycloak cannot be asked (local dev)', async () => {
    expect(await run(undefined, 'grant', 'kc-dev', 'support', '--by', 'tar', '--reason', 'local testing')).toBe(0);
    expect(lines).toContain('warning: Keycloak admin client not configured, so the one-time code was not checked');
  });

  it('reads the credential types from the Keycloak admin API', async () => {
    const calls: string[] = [];
    const creds: Record<string, object[]> = { a: [{ type: 'password' }, { type: 'otp' }], b: [{ type: 'password' }] };
    const fetchFake = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      if (url.endsWith('/token')) return new Response(JSON.stringify({ access_token: 'x', expires_in: 300 }), { status: 200 });
      const m = /\/users\/([^/]+)\/credentials$/.exec(url);
      return new Response(JSON.stringify(creds[m![1]] ?? []), { status: 200 });
    }) as typeof fetch;
    const config = { idpAdmin: { tokenUrl: 'https://kc.test/token', adminBase: 'https://kc.test/admin/realms/t', clientId: 'c', clientSecret: 's' } } as AppConfig;
    const idp = new IdpUsersService(config, fetchFake);
    expect(await idp.hasOtp('a')).toBe(true);
    expect(await idp.hasOtp('b')).toBe(false);
    expect(calls).toContain('GET https://kc.test/admin/realms/t/users/a/credentials');
  });
});
