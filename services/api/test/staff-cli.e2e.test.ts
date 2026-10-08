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
  const run = (otp: ((s: string) => Promise<string[]>) | undefined, ...args: string[]) => runStaffCli(args, new Database(pool), (l) => lines.push(l), otp);

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.url });
  });
  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it('refuses a grant to someone without a code, grants once they have one, and never checks for a revoke', async () => {
    expect(await run(async () => [], 'grant', 'kc-new', 'admin', '--by', 'tar', '--reason', 'new reviewer')).toBe(3);
    expect(lines.pop()).toMatch(/no one-time code yet/);
    expect((await pool.query(`SELECT 1 FROM staff_roles`)).rows).toEqual([]);
    expect(await run(async () => ['code-1'], 'grant', 'kc-new', 'admin', '--by', 'tar', '--reason', 'new reviewer')).toBe(0);
    const never = async () => {
      throw new Error('not asked');
    };
    expect(await run(never, 'revoke', 'kc-new', 'admin', '--by', 'tar', '--reason', 'left the team')).toBe(0);
    expect((await pool.query(`SELECT credential_ids, pinned_by FROM staff_mfa_pins`)).rows).toEqual([{ credential_ids: ['code-1'], pinned_by: 'tar' }]);
  });

  it('pin-mfa needs Keycloak, an existing account and a code', async () => {
    expect(await run(undefined, 'pin-mfa', 'kc-new', '--by', 'tar', '--reason', 'new phone')).toBe(2);
    expect(await run(async () => [], 'pin-mfa', 'kc-new', '--by', 'tar', '--reason', 'new phone')).toBe(3);
    expect(await run(async () => ['code-2'], 'pin-mfa', 'kc-nobody', '--by', 'tar', '--reason', 'new phone')).toBe(1);
    expect(await run(async () => ['code-2'], 'pin-mfa', 'kc-new', '--by', 'tar', '--reason', 'new phone')).toBe(0);
    expect((await pool.query(`SELECT credential_ids FROM staff_mfa_pins`)).rows).toEqual([{ credential_ids: ['code-2'] }]);
    expect(await run(async () => ['code-2'], 'pin-mfa', '--by', 'tar', '--reason', 'x')).toBe(2);
  });

  it('warns but grants where Keycloak cannot be asked (local dev)', async () => {
    expect(await run(undefined, 'grant', 'kc-dev', 'support', '--by', 'tar', '--reason', 'local testing')).toBe(0);
    expect(lines).toContain('warning: Keycloak admin client not configured, so the one-time code was not checked');
  });

  it('reads the one-time-code credential ids from the Keycloak admin API, oldest first', async () => {
    const calls: string[] = [];
    const creds: Record<string, object[]> = { a: [{ id: 'p', type: 'password' }, { id: 'o2', type: 'otp', createdDate: 5 }, { id: 'o1', type: 'otp', createdDate: 1 }], b: [{ id: 'p', type: 'password' }] };
    const fetchFake = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      if (url.endsWith('/token')) return new Response(JSON.stringify({ access_token: 'x', expires_in: 300 }), { status: 200 });
      const m = /\/users\/([^/]+)\/credentials$/.exec(url);
      return new Response(JSON.stringify(creds[m![1]] ?? []), { status: 200 });
    }) as typeof fetch;
    const config = { idpAdmin: { tokenUrl: 'https://kc.test/token', adminBase: 'https://kc.test/admin/realms/t', clientId: 'c', clientSecret: 's' } } as AppConfig;
    const idp = new IdpUsersService(config, fetchFake);
    expect(await idp.otpCredentialIds('a')).toEqual(['o1', 'o2']);
    expect(await idp.otpCredentialIds('b')).toEqual([]);
    expect(calls).toContain('GET https://kc.test/admin/realms/t/users/a/credentials');
  });
});
