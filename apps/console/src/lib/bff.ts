import { randomUUID } from 'node:crypto';
import type { ConsoleConfig } from './config';
import {
  clearCookie,
  cookieNames,
  openTransaction,
  readCookie,
  safeEqual,
  safeReturnTo,
  sealTransaction,
  serializeCookie,
} from './cookies';
import { createLogger, LogWriter } from './log';
import { OidcClient, OidcError, randomToken, TokenSet } from './oidc';
import type { Session, SessionStore } from './session';

export interface BffDeps {
  config: ConsoleConfig;
  oidc: OidcClient;
  store: SessionStore;
  fetchImpl?: typeof fetch;
  logWriter?: LogWriter;
}

type BffCode = 'SESSION_EXPIRED' | 'CSRF_REJECTED' | 'UNSUPPORTED_MEDIA_TYPE' | 'PAYLOAD_TOO_LARGE' | 'UPSTREAM_UNAVAILABLE';
const MESSAGE_KEYS: Record<BffCode, string> = {
  SESSION_EXPIRED: 'errors.auth.sessionExpired',
  CSRF_REJECTED: 'errors.auth.csrfRejected',
  UNSUPPORTED_MEDIA_TYPE: 'errors.request.unsupportedMediaType',
  PAYLOAD_TOO_LARGE: 'errors.request.tooLarge',
  UPSTREAM_UNAVAILABLE: 'errors.service.unavailable',
};

export interface SettingsView {
  revision: number;
  schemaVersion: number;
  settings: { theme: string; language: string; cellularPolicy: string };
  updatedAt: string | null;
}

export interface DeviceView {
  id: string;
  platform: 'ios' | 'android';
  osMajor: number;
  appBuild: string;
  appliedSettingsRevision: number;
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface DevicesView {
  settingsRevision: number;
  devices: DeviceView[];
}

export type SessionContext = { id: string; session: Session };

const LOGIN_TX_SECONDS = 600;
const REFRESH_SKEW_MS = 30_000;
const MAX_BODY_BYTES = 16 * 1024;

export function createBff(deps: BffDeps) {
  const { config, oidc, store } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = createLogger(deps.logWriter);
  const names = cookieNames(config.secureCookies);
  const secure = config.secureCookies;

  const json = (status: number, body: unknown, requestId: string, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-request-id': requestId, ...headers },
    });
  const error = (status: number, code: BffCode, requestId: string, extra: Record<string, string> = {}) =>
    json(status, { code, messageKey: MESSAGE_KEYS[code], requestId, details: {} }, requestId, extra);
  const redirect = (location: string, status = 302, setCookies: string[] = []) => {
    const headers = new Headers({ location, 'cache-control': 'no-store' });
    for (const c of setCookies) headers.append('set-cookie', c);
    return new Response(null, { status, headers });
  };

  async function timed(req: Request, route: string, run: (requestId: string) => Promise<Response>): Promise<Response> {
    const requestId = `web_${randomUUID()}`;
    const started = Date.now();
    let res: Response;
    try {
      res = await run(requestId);
    } catch {
      res = error(503, 'UPSTREAM_UNAVAILABLE', requestId);
    }
    log(res.status >= 500 ? 'ERROR' : res.status >= 400 ? 'WARN' : 'INFO', {
      eventCode: 'BFF_REQUEST',
      requestId,
      method: req.method,
      route,
      status: res.status,
      durationMs: Date.now() - started,
    });
    return res;
  }

  /** Reads the session from a Cookie header; null when absent, unknown or expired. */
  async function sessionFromCookie(cookieHeader: string | null | undefined): Promise<SessionContext | null> {
    const id = readCookie(cookieHeader, names.session);
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const session = await store.touch(id);
    return session ? { id, session } : null;
  }

  /** Returns a usable access token, refreshing it near expiry; null means the session has ended. */
  async function accessToken(ctx: SessionContext, force = false): Promise<string | null> {
    const { tokens } = ctx.session;
    if (!force && tokens.expiresAt - REFRESH_SKEW_MS > Date.now()) return tokens.accessToken;
    if (!tokens.refreshToken) {
      await store.delete(ctx.id);
      return null;
    }
    let next: TokenSet;
    try {
      next = await oidc.refresh(tokens.refreshToken);
    } catch (err) {
      if (err instanceof OidcError && err.kind === 'invalid_grant') {
        await store.delete(ctx.id);
        return null;
      }
      throw err;
    }
    ctx.session.tokens = { ...next, idToken: next.idToken ?? tokens.idToken };
    await store.update(ctx.id, ctx.session);
    return next.accessToken;
  }

  /** Calls the API as the session's user; retries once with a refreshed token on 401. */
  async function callApi(
    ctx: SessionContext,
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
    requestId: string,
  ): Promise<Response | null> {
    for (const force of [false, true]) {
      const token = await accessToken(ctx, force);
      if (!token) return null;
      const res = await fetchImpl(`${config.apiBaseUrl}${path}`, {
        method: init.method,
        headers: { ...init.headers, authorization: `Bearer ${token}`, 'x-request-id': requestId, accept: 'application/json' },
        body: init.body,
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (res.status !== 401) return res;
    }
    await store.delete(ctx.id);
    return null;
  }

  /** Mutations need the session's CSRF token in X-CSRF-Token (or a `csrf` form field) and a same-origin Origin header. */
  function csrfOk(req: Request, ctx: SessionContext, formToken?: string): boolean {
    const origin = req.headers.get('origin');
    if (origin !== config.baseUrl) return false;
    const token = req.headers.get('x-csrf-token') ?? formToken;
    return typeof token === 'string' && safeEqual(token, ctx.session.csrfToken);
  }

  async function passthrough(upstream: Response, requestId: string): Promise<Response> {
    const headers: Record<string, string> = {};
    const etag = upstream.headers.get('etag');
    if (etag) headers.etag = etag;
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-request-id': requestId, ...headers },
    });
  }

  return {
    names,
    sessionFromCookie,

    /** GET /auth/login — starts authorization code + PKCE; the destination is limited to /app/ paths. */
    login: (req: Request) =>
      timed(req, '/auth/login', async () => {
        const returnTo = safeReturnTo(new URL(req.url).searchParams.get('returnTo'));
        const tx = { state: randomToken(), nonce: randomToken(), codeVerifier: randomToken(48), returnTo, exp: Date.now() + LOGIN_TX_SECONDS * 1000 };
        const url = await oidc.authorizeUrl(tx);
        return redirect(url, 302, [
          serializeCookie(names.tx, sealTransaction(tx, config.sessionSecret), { secure, maxAgeSeconds: LOGIN_TX_SECONDS }),
        ]);
      }),

    /** GET /auth/callback — checks state, exchanges the code, verifies the ID token, starts a fresh session. */
    callback: (req: Request) =>
      timed(req, '/auth/callback', async () => {
        const params = new URL(req.url).searchParams;
        const cookieHeader = req.headers.get('cookie');
        const tx = openTransaction(readCookie(cookieHeader, names.tx), config.sessionSecret);
        const clearTx = clearCookie(names.tx, secure);
        const state = params.get('state');
        const code = params.get('code');
        if (!tx || !state || !code || params.get('error') || !safeEqual(state, tx.state)) {
          return redirect('/login?error=signin', 302, [clearTx]);
        }
        let tokens: TokenSet;
        try {
          tokens = await oidc.exchangeCode(code, tx.codeVerifier, tx.nonce);
        } catch (err) {
          const reason = err instanceof OidcError && err.kind === 'unavailable' ? 'unavailable' : 'signin';
          return redirect(`/login?error=${reason}`, 302, [clearTx]);
        }
        // Never reuse a session id that existed before login (session fixation).
        const previous = readCookie(cookieHeader, names.session);
        if (previous) await store.delete(previous);
        const { id } = await store.create(tokens);
        return redirect(tx.returnTo, 302, [clearTx, serializeCookie(names.session, id, { secure })]);
      }),

    /** POST /auth/logout — ends the local session, then the IdP session when the provider supports it. */
    logout: (req: Request) =>
      timed(req, '/auth/logout', async () => {
        const ctx = await sessionFromCookie(req.headers.get('cookie'));
        const clear = clearCookie(names.session, secure);
        const signedOut = `${config.baseUrl}/login?signedOut=1`;
        if (!ctx) return redirect('/login?signedOut=1', 303, [clear]);
        const form = req.headers.get('content-type')?.includes('application/x-www-form-urlencoded')
          ? new URLSearchParams(await req.text())
          : null;
        if (!csrfOk(req, ctx, form?.get('csrf') ?? undefined)) {
          return redirect('/app/settings?error=csrf', 303);
        }
        await store.delete(ctx.id);
        const endSession = await oidc.endSessionUrl(ctx.session.tokens.idToken, signedOut);
        return redirect(endSession ?? '/login?signedOut=1', 303, [clear]);
      }),

    /** Server-side read used by the settings page. Null means the user must sign in again. */
    async loadSettings(ctx: SessionContext): Promise<{ status: number; view?: SettingsView } | null> {
      const res = await callApi(ctx, '/v1/me/settings', { method: 'GET' }, `web_${randomUUID()}`);
      if (!res) return null;
      return res.ok ? { status: 200, view: (await res.json()) as SettingsView } : { status: res.status };
    },

    /** Server-side read of the account's devices for the settings page. Null means the user must sign in again. */
    async loadDevices(ctx: SessionContext): Promise<{ status: number; view?: DevicesView } | null> {
      const res = await callApi(ctx, '/v1/me/devices', { method: 'GET' }, `web_${randomUUID()}`);
      if (!res) return null;
      return res.ok ? { status: 200, view: (await res.json()) as DevicesView } : { status: res.status };
    },

    /** GET /bff/devices */
    getDevices: (req: Request) =>
      timed(req, '/bff/devices', async (requestId) => {
        const ctx = await sessionFromCookie(req.headers.get('cookie'));
        if (!ctx) return error(401, 'SESSION_EXPIRED', requestId);
        const upstream = await callApi(ctx, '/v1/me/devices', { method: 'GET' }, requestId);
        if (!upstream) return error(401, 'SESSION_EXPIRED', requestId, { 'set-cookie': clearCookie(names.session, secure) });
        return passthrough(upstream, requestId);
      }),

    /** GET /bff/settings */
    getSettings: (req: Request) =>
      timed(req, '/bff/settings', async (requestId) => {
        const ctx = await sessionFromCookie(req.headers.get('cookie'));
        if (!ctx) return error(401, 'SESSION_EXPIRED', requestId);
        const upstream = await callApi(ctx, '/v1/me/settings', { method: 'GET' }, requestId);
        if (!upstream) return error(401, 'SESSION_EXPIRED', requestId, { 'set-cookie': clearCookie(names.session, secure) });
        return passthrough(upstream, requestId);
      }),

    /** PATCH /bff/settings — forwards If-Match and the JSON body; the API validates values and revisions. */
    patchSettings: (req: Request) =>
      timed(req, '/bff/settings', async (requestId) => {
        const ctx = await sessionFromCookie(req.headers.get('cookie'));
        if (!ctx) return error(401, 'SESSION_EXPIRED', requestId);
        if (!csrfOk(req, ctx)) return error(403, 'CSRF_REJECTED', requestId);
        if (!req.headers.get('content-type')?.startsWith('application/json')) {
          return error(415, 'UNSUPPORTED_MEDIA_TYPE', requestId);
        }
        const body = await req.text();
        if (Buffer.byteLength(body) > MAX_BODY_BYTES) return error(413, 'PAYLOAD_TOO_LARGE', requestId);
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        const ifMatch = req.headers.get('if-match');
        if (ifMatch) headers['if-match'] = ifMatch;
        const upstream = await callApi(ctx, '/v1/me/settings', { method: 'PATCH', headers, body }, requestId);
        if (!upstream) return error(401, 'SESSION_EXPIRED', requestId, { 'set-cookie': clearCookie(names.session, secure) });
        return passthrough(upstream, requestId);
      }),
  };
}

export type Bff = ReturnType<typeof createBff>;
