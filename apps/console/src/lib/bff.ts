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

export interface DiagnosticReport {
  id: string;
  receivedAt: string;
  expiresAt: string;
  deviceId: string;
  platform: 'ios' | 'android' | null;
  eventCount: number;
  events: { eventName: string; count: number }[];
}

export interface DiagnosticsView {
  reports: DiagnosticReport[];
  retentionDays: number;
}

export type StaffRole = 'support' | 'catalog_editor' | 'operator' | 'admin' | 'auditor';

export interface StationDraft {
  name: string;
  country: string;
  language: string;
  genres: string[];
  streamUrl: string;
  codec: 'mp3' | 'aac' | 'hls';
  bitrateKbps: number | null;
  rightsBasis: string | null;
  rightsReference: string | null;
  rightsExpiresAt: string | null;
}

export interface AdminStation {
  id: string;
  revision: number;
  status: 'draft' | 'published' | 'changes_pending' | 'disabled';
  draft: StationDraft;
  published: StationDraft | null;
  publishedRevision: number | null;
  publishedAt: string | null;
  disabledAt: string | null;
  updatedAt: string;
  publishBlockers: string[];
  health: StationHealth;
}

export type HealthState = 'unknown' | 'ok' | 'failing' | 'suspect';

export interface RegionHealth {
  region: string;
  state: Exclude<HealthState, 'unknown'>;
  checkedAt: string;
  reason: string;
  httpStatus: number | null;
  latencyMs: number | null;
  consecutiveFailures: number;
}

/** Health of the published stream, from the API's scheduled checks (Doc 17). */
export interface StationHealth {
  state: HealthState;
  regions: RegionHealth[];
}

export interface HealthCheck {
  region: string;
  checkedAt: string;
  target: 'published' | 'draft';
  ok: boolean;
  reason: string;
  httpStatus: number | null;
  latencyMs: number | null;
}

/** Lower-case UUID: station ids and diagnostic report ids. */
const STATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Deletion tickets: 32 random bytes, base64url. */
const DELETION_TICKET = /^[A-Za-z0-9_-]{43}$/;
/** Device ids are UUIDs the phone app generates (any case; the API lower-cases them). */
const DEVICE_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const STATION_ACTIONS = ['publish', 'disable', 'enable', 'check'] as const;
export type StationAction = (typeof STATION_ACTIONS)[number];

export type SessionContext = { id: string; session: Session };

export interface LogEntry {
  id: string;
  timestamp: string;
  severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  service: string;
  environment: string;
  build: string;
  eventCode: string;
  requestId: string | null;
  method: string | null;
  route: string | null;
  status: number | null;
  durationMs: number | null;
  actorId: string | null;
  errorName: string | null;
  errorCode: string | null;
}
export interface LogPage {
  logs: LogEntry[];
  nextCursor: string | null;
  retentionDays: number;
}
export interface AuditEvent {
  id: string;
  occurredAt: string;
  actor: string;
  actorSubject: string | null;
  action: string;
  targetLabel: string | null;
  targetType: string;
  targetId: string;
  reason: string | null;
  changes: Record<string, unknown>;
  requestId: string | null;
}
export interface AuditPage {
  events: AuditEvent[];
  nextCursor: string | null;
}
/** Search fields the console forwards to GET /v1/admin/audit; anything else is dropped. The API validates values. */
export const AUDIT_PARAMS = ['from', 'to', 'actor', 'action', 'targetType', 'targetId', 'requestId', 'includeReads', 'limit', 'cursor'] as const;

/** Search fields the console forwards to GET /v1/admin/logs; anything else is dropped. The API validates values. */
export const LOG_PARAMS = ['from', 'to', 'severity', 'service', 'build', 'eventCode', 'requestId', 'status', 'limit', 'cursor'] as const;

const LOGIN_TX_SECONDS = 600;
/** Clock skew allowed between the IdP and the console when checking a re-authentication's auth_time. */
const REAUTH_SKEW_SECONDS = 30;
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
      // A step-up demand is not an expired token: hand it back without refreshing or ending the session.
      if ((await res.clone().json().catch(() => null))?.code === 'REAUTH_REQUIRED') return res;
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
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter && /^\d{1,3}$/.test(retryAfter)) headers['retry-after'] = retryAfter;
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-request-id': requestId, ...headers },
    });
  }

  async function markStaffAtLogin(id: string, session: Session): Promise<void> {
    const res = await fetchImpl(`${config.apiBaseUrl}/v1/me/staff`, {
      headers: { authorization: `Bearer ${session.tokens.accessToken}`, accept: 'application/json', 'x-request-id': `web_${randomUUID()}` },
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    });
    if (!res.ok) return;
    const { roles } = (await res.json()) as { roles: StaffRole[] };
    if (roles.length > 0) {
      session.staff = true;
      await store.update(id, session);
    }
  }

  /** Reads the caller's staff roles and marks the session as a staff session when there are any. */
  async function loadStaff(ctx: SessionContext): Promise<{ roles: StaffRole[] } | { status: number } | null> {
    const res = await callApi(ctx, '/v1/me/staff', { method: 'GET' }, `web_${randomUUID()}`);
    if (!res) return null;
    if (!res.ok) return { status: res.status };
    const { roles } = (await res.json()) as { roles: StaffRole[] };
    if (roles.length > 0 && !ctx.session.staff) {
      ctx.session.staff = true;
      await store.update(ctx.id, ctx.session);
    }
    return { roles };
  }

  /** Forwards one staff call to the API. The API enforces roles; the BFF adds session, CSRF and size checks. */
  async function adminProxy(req: Request, requestId: string, apiPath: string, mutation: boolean): Promise<Response> {
    const ctx = await sessionFromCookie(req.headers.get('cookie'));
    if (!ctx) return error(401, 'SESSION_EXPIRED', requestId);
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (mutation) {
      if (!csrfOk(req, ctx)) return error(403, 'CSRF_REJECTED', requestId);
      if (!req.headers.get('content-type')?.startsWith('application/json')) return error(415, 'UNSUPPORTED_MEDIA_TYPE', requestId);
      body = await req.text();
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) return error(413, 'PAYLOAD_TOO_LARGE', requestId);
      headers['content-type'] = 'application/json';
      const ifMatch = req.headers.get('if-match');
      if (ifMatch) headers['if-match'] = ifMatch;
    }
    const upstream = await callApi(ctx, apiPath, { method: req.method, headers, body }, requestId);
    if (!upstream) return error(401, 'SESSION_EXPIRED', requestId, { 'set-cookie': clearCookie(names.session, secure) });
    return passthrough(upstream, requestId);
  }

  const notFound = (requestId: string) =>
    json(404, { code: 'NOT_FOUND', messageKey: 'errors.request.notFound', requestId, details: {} }, requestId);

  return {
    names,
    sessionFromCookie,
    loadStaff,

    /** Server-side read for staff pages: list (no id) or one station. Null means the user must sign in again. */
    async loadStations(ctx: SessionContext): Promise<{ status: number; stations?: AdminStation[] } | null> {
      const res = await callApi(ctx, '/v1/admin/stations', { method: 'GET' }, `web_${randomUUID()}`);
      if (!res) return null;
      return res.ok ? { status: 200, stations: ((await res.json()) as { stations: AdminStation[] }).stations } : { status: res.status };
    },
    async loadStation(ctx: SessionContext, id: string): Promise<{ status: number; station?: AdminStation } | null> {
      if (!STATION_ID.test(id)) return { status: 404 };
      const res = await callApi(ctx, `/v1/admin/stations/${id}`, { method: 'GET' }, `web_${randomUUID()}`);
      if (!res) return null;
      return res.ok ? { status: 200, station: (await res.json()) as AdminStation } : { status: res.status };
    },
    async loadStationHealth(ctx: SessionContext, id: string): Promise<{ status: number; checks?: HealthCheck[] } | null> {
      if (!STATION_ID.test(id)) return { status: 404 };
      const res = await callApi(ctx, `/v1/admin/stations/${id}/health`, { method: 'GET' }, `web_${randomUUID()}`);
      if (!res) return null;
      return res.ok ? { status: 200, checks: ((await res.json()) as { checks: HealthCheck[] }).checks } : { status: res.status };
    },

    /** Server-side log search for /admin/logs. Null means the user must sign in again. */
    async loadLogs(
      ctx: SessionContext,
      params: Partial<Record<(typeof LOG_PARAMS)[number], string>>,
    ): Promise<{ status: number; page?: LogPage; field?: string } | null> {
      const qs = new URLSearchParams();
      for (const k of LOG_PARAMS) {
        const v = params[k];
        if (typeof v === 'string' && v && v.length <= 200) qs.set(k, v);
      }
      const res = await callApi(ctx, `/v1/admin/logs?${qs}`, { method: 'GET' }, `web_${randomUUID()}`);
      if (!res) return null;
      if (res.ok) return { status: 200, page: (await res.json()) as LogPage };
      const body = (await res.json().catch(() => ({}))) as { details?: { field?: string } };
      return { status: res.status, field: body.details?.field };
    },

    /** Server-side audit search for /admin/audit. Null means the user must sign in again. */
    async loadAudit(
      ctx: SessionContext,
      params: Partial<Record<(typeof AUDIT_PARAMS)[number], string>>,
    ): Promise<{ status: number; page?: AuditPage; field?: string } | null> {
      const qs = new URLSearchParams();
      for (const k of AUDIT_PARAMS) {
        const v = params[k];
        if (typeof v === 'string' && v && v.length <= 200) qs.set(k, v);
      }
      const res = await callApi(ctx, `/v1/admin/audit?${qs}`, { method: 'GET' }, `web_${randomUUID()}`);
      if (!res) return null;
      if (res.ok) return { status: 200, page: (await res.json()) as AuditPage };
      const body = (await res.json().catch(() => ({}))) as { details?: { field?: string } };
      return { status: res.status, field: body.details?.field };
    },

    /**
     * POST /bff/admin/audit/export: the current audit search as CSV, with `{ reason }` in the JSON body.
     * The API checks the role, bounds the rows and records the export with its reason.
     */
    auditExport: (req: Request) =>
      timed(req, '/bff/admin/audit/export', async (requestId) => {
        const ctx = await sessionFromCookie(req.headers.get('cookie'));
        if (!ctx) return error(401, 'SESSION_EXPIRED', requestId);
        if (!csrfOk(req, ctx)) return error(403, 'CSRF_REJECTED', requestId);
        if (!req.headers.get('content-type')?.startsWith('application/json')) return error(415, 'UNSUPPORTED_MEDIA_TYPE', requestId);
        const body = await req.text();
        if (Buffer.byteLength(body) > MAX_BODY_BYTES) return error(413, 'PAYLOAD_TOO_LARGE', requestId);
        const incoming = new URL(req.url).searchParams;
        const qs = new URLSearchParams();
        for (const k of AUDIT_PARAMS) {
          const v = incoming.get(k);
          if (k !== 'cursor' && k !== 'limit' && v && v.length <= 200) qs.set(k, v);
        }
        const upstream = await callApi(ctx, `/v1/admin/audit/export?${qs}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, requestId);
        if (!upstream) return error(401, 'SESSION_EXPIRED', requestId, { 'set-cookie': clearCookie(names.session, secure) });
        if (!upstream.ok) return passthrough(upstream, requestId);
        const disposition = upstream.headers.get('content-disposition') ?? '';
        return new Response(await upstream.arrayBuffer(), {
          status: 200,
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'cache-control': 'no-store',
            'x-request-id': requestId,
            'content-disposition': /^attachment; filename="[\w.-]{1,64}"$/.test(disposition) ? disposition : 'attachment; filename="tunedeck-audit.csv"',
          },
        });
      }),

    /** GET/POST /bff/admin/stations */
    stations: (req: Request) =>
      timed(req, '/bff/admin/stations', (requestId) => adminProxy(req, requestId, '/v1/admin/stations', req.method === 'POST')),

    /** GET/PATCH /bff/admin/stations/{id} */
    station: (req: Request, id: string) =>
      timed(req, '/bff/admin/stations/:id', async (requestId) =>
        STATION_ID.test(id) ? adminProxy(req, requestId, `/v1/admin/stations/${id}`, req.method === 'PATCH') : notFound(requestId),
      ),

    /** POST /bff/admin/stations/{id}/{publish|disable|enable|check} */
    stationAction: (req: Request, id: string, action: string) =>
      timed(req, '/bff/admin/stations/:id/:action', async (requestId) =>
        STATION_ID.test(id) && (STATION_ACTIONS as readonly string[]).includes(action)
          ? adminProxy(req, requestId, `/v1/admin/stations/${id}/${action}`, true)
          : notFound(requestId),
      ),

    /**
     * GET /auth/login — starts authorization code + PKCE; the destination is limited to /app/ paths.
     * `reauth=1` makes the provider ask for credentials again, for actions that need a recent sign-in.
     */
    login: (req: Request) =>
      timed(req, '/auth/login', async () => {
        const params = new URL(req.url).searchParams;
        const returnTo = safeReturnTo(params.get('returnTo'));
        const reauth = params.get('reauth') === '1';
        const tx = {
          state: randomToken(),
          nonce: randomToken(),
          codeVerifier: randomToken(48),
          returnTo,
          exp: Date.now() + LOGIN_TX_SECONDS * 1000,
          ...(reauth ? { reauthSince: Math.floor(Date.now() / 1000) } : {}),
        };
        const url = await oidc.authorizeUrl({ ...tx, reauth });
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
          const { authTime, ...issued } = await oidc.exchangeCode(code, tx.codeVerifier, tx.nonce);
          // A re-authentication must be a fresh sign-in, not the provider quietly reusing its SSO session.
          if (tx.reauthSince !== undefined && (authTime === undefined || authTime < tx.reauthSince - REAUTH_SKEW_SECONDS)) {
            return redirect(`${tx.returnTo.split('?')[0]}?reauth=failed`, 302, [clearTx]);
          }
          tokens = issued;
        } catch (err) {
          const reason = err instanceof OidcError && err.kind === 'unavailable' ? 'unavailable' : 'signin';
          return redirect(`/login?error=${reason}`, 302, [clearTx]);
        }
        // Never reuse a session id that existed before login (session fixation).
        const previous = readCookie(cookieHeader, names.session);
        if (previous) await store.delete(previous);
        const created = await store.create(tokens);
        const { id } = created;
        // Staff accounts get the shorter staff session lifetime from the start. This uses the new access token once,
        // with no refresh and no session cleanup, so a failed lookup never ends a fresh login; /admin checks again.
        await markStaffAtLogin(id, created.session).catch(() => undefined);
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

    /** Server-side read of the account's own diagnostic reports for /app/privacy. Null means sign in again. */
    async loadDiagnostics(ctx: SessionContext): Promise<{ status: number; view?: DiagnosticsView } | null> {
      const res = await callApi(ctx, '/v1/me/diagnostics', { method: 'GET' }, `web_${randomUUID()}`);
      if (!res) return null;
      return res.ok ? { status: 200, view: (await res.json()) as DiagnosticsView } : { status: res.status };
    },

    /** DELETE /bff/diagnostics/{id}: the owner removes one of their own reports. */
    deleteDiagnostic: (req: Request, id: string) =>
      timed(req, '/bff/diagnostics/:id', async (requestId) => {
        if (!STATION_ID.test(id)) return notFound(requestId);
        const ctx = await sessionFromCookie(req.headers.get('cookie'));
        if (!ctx) return error(401, 'SESSION_EXPIRED', requestId);
        if (!csrfOk(req, ctx)) return error(403, 'CSRF_REJECTED', requestId);
        const upstream = await callApi(ctx, `/v1/me/diagnostics/${id}`, { method: 'DELETE' }, requestId);
        if (!upstream) return error(401, 'SESSION_EXPIRED', requestId, { 'set-cookie': clearCookie(names.session, secure) });
        if (upstream.status === 204) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', 'x-request-id': requestId } });
        return passthrough(upstream, requestId);
      }),

    /** GET /bff/devices */
    getDevices: (req: Request) =>
      timed(req, '/bff/devices', async (requestId) => {
        const ctx = await sessionFromCookie(req.headers.get('cookie'));
        if (!ctx) return error(401, 'SESSION_EXPIRED', requestId);
        const upstream = await callApi(ctx, '/v1/me/devices', { method: 'GET' }, requestId);
        if (!upstream) return error(401, 'SESSION_EXPIRED', requestId, { 'set-cookie': clearCookie(names.session, secure) });
        return passthrough(upstream, requestId);
      }),

    /**
     * DELETE /bff/devices/{id}/session: signs one of the account's phones out. The API demands a sign-in from the
     * last 5 minutes and answers 401 REAUTH_REQUIRED otherwise; that answer passes through with the session intact.
     */
    revokeDevice: (req: Request, id: string) =>
      timed(req, '/bff/devices/:id/session', async (requestId) => {
        if (!DEVICE_ID.test(id)) return notFound(requestId);
        const ctx = await sessionFromCookie(req.headers.get('cookie'));
        if (!ctx) return error(401, 'SESSION_EXPIRED', requestId);
        if (!csrfOk(req, ctx)) return error(403, 'CSRF_REJECTED', requestId);
        const upstream = await callApi(ctx, `/v1/me/devices/${id}/session`, { method: 'DELETE' }, requestId);
        if (!upstream) return error(401, 'SESSION_EXPIRED', requestId, { 'set-cookie': clearCookie(names.session, secure) });
        return passthrough(upstream, requestId);
      }),

    /** GET /bff/account/export: the account's own data as a JSON download (Doc 17). */
    exportAccount: (req: Request) =>
      timed(req, '/bff/account/export', async (requestId) => {
        const ctx = await sessionFromCookie(req.headers.get('cookie'));
        if (!ctx) return error(401, 'SESSION_EXPIRED', requestId);
        const upstream = await callApi(ctx, '/v1/me/export', { method: 'GET' }, requestId);
        if (!upstream) return error(401, 'SESSION_EXPIRED', requestId, { 'set-cookie': clearCookie(names.session, secure) });
        if (!upstream.ok) return passthrough(upstream, requestId);
        const disposition = upstream.headers.get('content-disposition') ?? '';
        return new Response(await upstream.text(), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'x-request-id': requestId,
            'content-disposition': /^attachment; filename="[\w.-]{1,64}"$/.test(disposition) ? disposition : 'attachment; filename="tunedeck-export.json"',
          },
        });
      }),

    /**
     * DELETE /bff/account: asks the API to delete the account (needs a recent sign-in, like device sign-out).
     * On 202 the web session ends here too and the browser gets the ticket to follow progress with.
     */
    deleteAccount: (req: Request) =>
      timed(req, '/bff/account', async (requestId) => {
        const ctx = await sessionFromCookie(req.headers.get('cookie'));
        if (!ctx) return error(401, 'SESSION_EXPIRED', requestId);
        if (!csrfOk(req, ctx)) return error(403, 'CSRF_REJECTED', requestId);
        const upstream = await callApi(ctx, '/v1/me/account', { method: 'DELETE' }, requestId);
        if (!upstream) return error(401, 'SESSION_EXPIRED', requestId, { 'set-cookie': clearCookie(names.session, secure) });
        if (upstream.status !== 202) return passthrough(upstream, requestId);
        const { ticket, status } = (await upstream.json()) as { ticket: string; status: string };
        await store.delete(ctx.id);
        return json(202, { ticket, status }, requestId, { 'set-cookie': clearCookie(names.session, secure) });
      }),

    /** GET /bff/account-deletions/{ticket}: deletion progress. No session: the account can no longer sign in. */
    deletionStatus: (req: Request, ticket: string) =>
      timed(req, '/bff/account-deletions/:ticket', async (requestId) => {
        if (!DELETION_TICKET.test(ticket)) return notFound(requestId);
        const upstream = await fetchImpl(`${config.apiBaseUrl}/v1/account-deletions/${ticket}`, {
          headers: { accept: 'application/json', 'x-request-id': requestId },
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        });
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
