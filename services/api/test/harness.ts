import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createLocalJWKSet, exportJWK, generateKeyPair, JWTVerifyGetKey, KeyLike, SignJWT } from 'jose';
import { Client, Pool } from 'pg';
import { AppDeps, AppModule, configureApp } from '../src/app.module';
import { AppConfig } from '../src/config';
import { createPool } from '../src/db/database';
import { migrate } from '../src/db/migrate';

/**
 * Test-only identity: a locally generated signing key stands in for the OIDC
 * provider's JWKS. This lives in test/ and is never wired into the runtime build.
 */
export const ISSUER = 'https://idp.test/realms/tunedeck';
export const AUDIENCE = 'tunedeck-api';

export interface TestIdentity {
  keyResolver: JWTVerifyGetKey;
  token(sub: string, overrides?: { iss?: string; aud?: string; expSeconds?: number; key?: KeyLike; kid?: string; authTime?: number; email?: string; emailVerified?: boolean }): Promise<string>;
  foreignKey: KeyLike;
}

export async function createIdentity(): Promise<TestIdentity> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key-1', alg: 'RS256', use: 'sig' };
  return {
    keyResolver: createLocalJWKSet({ keys: [jwk] }),
    foreignKey: foreign.privateKey,
    async token(sub, o = {}) {
      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = {};
      if (o.authTime !== undefined) claims.auth_time = o.authTime;
      if (o.email !== undefined) Object.assign(claims, { email: o.email, email_verified: o.emailVerified ?? true });
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: o.kid ?? 'test-key-1' })
        .setSubject(sub)
        .setIssuer(o.iss ?? ISSUER)
        .setAudience(o.aud ?? AUDIENCE)
        .setIssuedAt(now)
        .setExpirationTime(now + (o.expSeconds ?? 300))
        .sign(o.key ?? privateKey);
    },
  };
}

export function testConfig(databaseUrl: string): AppConfig {
  return {
    env: 'dev',
    build: 'test',
    port: 0,
    databaseUrl,
    oidc: { issuer: ISSUER, audience: AUDIENCE, jwksUri: 'https://idp.test/unused', algorithms: ['RS256'] },
    rateLimit: { enabled: false, readsPerMinute: 120, writesPerMinute: 30, catalogPerMinutePerIp: 60, trustProxyHops: 0 },
    billing: { apple: null, google: null },
    auditRetentionEnabled: false,
    stationCheck: { enabled: false, intervalMinutes: 15, region: 'test-region' },
    configSigningKey: null,
    idpAdmin: {
      tokenUrl: 'https://idp.test/realms/tunedeck/protocol/openid-connect/token',
      adminBase: 'https://idp.test/admin/realms/tunedeck',
      clientId: 'tunedeck-api-admin',
      clientSecret: 'test-only-secret',
    },
  };
}

/**
 * Test-only Keycloak admin API: issues client-credentials tokens and deletes users by id. Every user exists
 * until deleted; `failDeletes` makes the delete call answer 503.
 */
export function createFakeIdp() {
  const deleted: string[] = [];
  const state = { failDeletes: false, tokenRequests: 0 };
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === 'https://idp.test/realms/tunedeck/protocol/openid-connect/token') {
      const ok = init?.method === 'POST' && (init.headers as Record<string, string>).Authorization === `Basic ${Buffer.from('tunedeck-api-admin:test-only-secret').toString('base64')}`;
      if (!ok) return new Response('{}', { status: 401 });
      state.tokenRequests++;
      return Response.json({ access_token: 'admin-token', expires_in: 300 });
    }
    const m = /^https:\/\/idp\.test\/admin\/realms\/tunedeck\/users\/([^/]+)$/.exec(url);
    if (m && init?.method === 'DELETE') {
      if ((init.headers as Record<string, string>).Authorization !== 'Bearer admin-token') return new Response(null, { status: 401 });
      if (state.failDeletes) return new Response(null, { status: 503 });
      const id = decodeURIComponent(m[1]);
      if (deleted.includes(id)) return new Response(null, { status: 404 });
      deleted.push(id);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  };
  return { fetch: fetch as typeof globalThis.fetch, deleted, state };
}

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/postgres';

/** Creates a throwaway database with migrations applied. */
export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `tunedeck_test_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() });
  await migrate(pool, join(__dirname, '../src/db/migrations'));
  await pool.end();
  return {
    url: url.toString(),
    drop: async () => {
      const c = new Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

export async function createTestApp(databaseUrl: string, keyResolver: JWTVerifyGetKey, extra: Pick<AppDeps, 'probeDeps' | 'googleFetch' | 'googlePushKeys'> & { config?: Partial<AppConfig> } = {}) {
  const pool = createPool(databaseUrl);
  const logs: string[] = [];
  const idp = createFakeIdp();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ config: { ...testConfig(databaseUrl), ...extra.config }, pool, keyResolver, logWriter: (l) => logs.push(l), probeDeps: extra.probeDeps, idpFetch: idp.fetch, googleFetch: extra.googleFetch, googlePushKeys: extra.googlePushKeys })],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.init();
  return {
    app,
    pool,
    idp,
    logs: captureFrom(logs),
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

/** Reads structured log lines written by the app since `mark()`. */
function captureFrom(buffer: string[]) {
  let start = 0;
  const since = () => buffer.slice(start).join('');
  return {
    mark: () => {
      start = buffer.length;
    },
    raw: since,
    lines: (): Record<string, unknown>[] =>
      since()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
  };
}
