import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, JWTVerifyGetKey } from 'jose';
import type { ConsoleConfig } from './config';

export interface TokenSet {
  accessToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  refreshToken?: string;
  idToken?: string;
}

interface Metadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export class OidcError extends Error {
  constructor(readonly kind: 'invalid_grant' | 'unavailable' | 'invalid_response') {
    super(`oidc_${kind}`);
    this.name = 'OidcError';
  }
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/**
 * Confidential OIDC client for the web BFF: authorization code + PKCE S256,
 * client_secret_basic at the token endpoint, ID token checked for issuer,
 * audience, signature and nonce. No implicit flow and no password grant.
 */
export class OidcClient {
  private metadataPromise?: Promise<Metadata>;
  private jwks?: JWTVerifyGetKey;

  constructor(
    private readonly config: ConsoleConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get redirectUri(): string {
    return `${this.config.baseUrl}/auth/callback`;
  }

  metadata(): Promise<Metadata> {
    this.metadataPromise ??= (async () => {
      const url = `${this.config.oidc.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
      const res = await this.call(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new OidcError('unavailable');
      const m = (await res.json()) as Metadata;
      if (m.issuer !== this.config.oidc.issuer) throw new OidcError('invalid_response');
      return m;
    })().catch((err) => {
      this.metadataPromise = undefined;
      throw err;
    });
    return this.metadataPromise;
  }

  /** With `reauth`, asks the provider to prompt for credentials again even inside a live SSO session (OIDC max_age=0). */
  async authorizeUrl(p: { state: string; nonce: string; codeVerifier: string; reauth?: boolean }): Promise<string> {
    const m = await this.metadata();
    const url = new URL(m.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.oidc.clientId,
      redirect_uri: this.redirectUri,
      scope: this.config.oidc.scopes,
      state: p.state,
      nonce: p.nonce,
      code_challenge: pkceChallenge(p.codeVerifier),
      code_challenge_method: 'S256',
      ...(p.reauth ? { prompt: 'login', max_age: '0' } : {}),
    }).toString();
    return url.toString();
  }

  /** Returns the tokens and the ID token's `auth_time` (epoch seconds) when it has one. */
  async exchangeCode(code: string, codeVerifier: string, nonce: string): Promise<TokenSet & { authTime?: number }> {
    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      code_verifier: codeVerifier,
    });
    if (!tokens.idToken) throw new OidcError('invalid_response');
    const authTime = await this.verifyIdToken(tokens.idToken, nonce);
    return { ...tokens, authTime };
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async endSessionUrl(idToken: string | undefined, postLogoutRedirect: string): Promise<string | null> {
    const m = await this.metadata().catch(() => null);
    if (!m?.end_session_endpoint) return null;
    const url = new URL(m.end_session_endpoint);
    url.searchParams.set('client_id', this.config.oidc.clientId);
    url.searchParams.set('post_logout_redirect_uri', postLogoutRedirect);
    if (idToken) url.searchParams.set('id_token_hint', idToken);
    return url.toString();
  }

  private async verifyIdToken(idToken: string, nonce: string): Promise<number | undefined> {
    const m = await this.metadata();
    this.jwks ??= createRemoteJWKSet(new URL(m.jwks_uri), { timeoutDuration: 5000, cacheMaxAge: 10 * 60_000 });
    try {
      const { payload } = await jwtVerify(idToken, this.jwks, {
        issuer: this.config.oidc.issuer,
        audience: this.config.oidc.clientId,
        algorithms: this.config.oidc.algorithms,
        requiredClaims: ['sub', 'exp', 'nonce'],
      });
      if (payload.nonce !== nonce) throw new OidcError('invalid_response');
      return typeof payload.auth_time === 'number' ? payload.auth_time : undefined;
    } catch {
      throw new OidcError('invalid_response');
    }
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenSet> {
    const m = await this.metadata();
    const basic = Buffer.from(
      `${encodeURIComponent(this.config.oidc.clientId)}:${encodeURIComponent(this.config.oidc.clientSecret)}`,
    ).toString('base64');
    const res = await this.call(m.token_endpoint, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    });
    if (res.status === 400 || res.status === 401) throw new OidcError('invalid_grant');
    if (!res.ok) throw new OidcError('unavailable');
    const body = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string; id_token?: string };
    if (!body.access_token || typeof body.expires_in !== 'number') throw new OidcError('invalid_response');
    return {
      accessToken: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
      refreshToken: body.refresh_token ?? params.refresh_token,
      idToken: body.id_token,
    };
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(5000), redirect: 'error' });
    } catch {
      throw new OidcError('unavailable');
    }
  }
}
