import { createHash, randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, KeyLike, SignJWT } from 'jose';

/**
 * Test-only OpenID provider: discovery, authorize (auto-approves the current
 * test user), token (code + PKCE, refresh rotation), JWKS and end-session.
 * It exists so the BFF and the real API can be exercised end to end.
 */
export interface MockIdp {
  issuer: string;
  close(): Promise<void>;
  setUser(sub: string): void;
  setAccessTtl(seconds: number): void;
  revokeRefreshTokens(): void;
  issued: string[];
}

export const CLIENT_ID = 'tunedeck-console';
export const CLIENT_SECRET = 'test-secret';
export const API_AUDIENCE = 'tunedeck-api';

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

export async function startMockIdp(): Promise<MockIdp> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'idp-1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { sub: string; nonce: string; challenge: string; redirectUri: string }>();
  const refresh = new Map<string, string>();
  const issued: string[] = [];
  let user = 'alice';
  let accessTtl = 300;
  let issuer = '';

  const sign = (claims: Record<string, unknown>, aud: string, ttl: number, key: KeyLike = privateKey) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'idp-1' }).setIssuer(issuer).setAudience(aud).setIssuedAt(now).setExpirationTime(now + ttl).sign(key);
  };

  async function tokens(sub: string, nonce?: string) {
    const access = await sign({ sub }, API_AUDIENCE, accessTtl);
    const id = nonce !== undefined ? await sign({ sub, nonce }, CLIENT_ID, 300) : undefined;
    const rt = randomBytes(24).toString('base64url');
    refresh.set(rt, sub);
    issued.push(access, rt, ...(id ? [id] : []));
    return { access_token: access, token_type: 'Bearer', expires_in: accessTtl, refresh_token: rt, ...(id ? { id_token: id } : {}) };
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return send(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        end_session_endpoint: `${issuer}/logout`,
      });
    }
    if (url.pathname === '/jwks') return send(200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      if (p.get('client_id') !== CLIENT_ID || p.get('code_challenge_method') !== 'S256' || p.get('response_type') !== 'code') {
        return send(400, { error: 'invalid_request' });
      }
      const code = randomBytes(16).toString('base64url');
      codes.set(code, { sub: user, nonce: p.get('nonce')!, challenge: p.get('code_challenge')!, redirectUri: p.get('redirect_uri')! });
      const back = new URL(p.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', p.get('state')!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/logout') {
      res.writeHead(302, { location: url.searchParams.get('post_logout_redirect_uri') ?? '/' });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const auth = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
      if (auth !== `${CLIENT_ID}:${CLIENT_SECRET}`) return send(401, { error: 'invalid_client' });
      const p = new URLSearchParams(await body(req));
      if (p.get('grant_type') === 'authorization_code') {
        const entry = codes.get(p.get('code') ?? '');
        codes.delete(p.get('code') ?? '');
        const verifier = p.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (!entry || entry.redirectUri !== p.get('redirect_uri') || entry.challenge !== challenge) {
          return send(400, { error: 'invalid_grant' });
        }
        return send(200, await tokens(entry.sub, entry.nonce));
      }
      if (p.get('grant_type') === 'refresh_token') {
        const sub = refresh.get(p.get('refresh_token') ?? '');
        if (!sub) return send(400, { error: 'invalid_grant' });
        refresh.delete(p.get('refresh_token')!); // rotation: each refresh token works once
        return send(200, await tokens(sub));
      }
      return send(400, { error: 'unsupported_grant_type' });
    }
    send(404, { error: 'not_found' });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    issued,
    close: () => new Promise((r) => server.close(() => r())),
    setUser: (s) => (user = s),
    setAccessTtl: (s) => (accessTtl = s),
    revokeRefreshTokens: () => refresh.clear(),
  };
}
