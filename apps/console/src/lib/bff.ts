import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
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
import { createLogger, LogWriter, traceIdFrom } from './log';
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
  /** When the phone last finished a sync; null if it never synced. */
  lastSyncedAt: string | null;
  revokedAt: string | null;
  /** Settings this device sets differently from the account; {} follows the account. */
  overrides: Partial<SettingsView['settings']>;
  preferencesRevision: number;
}

export interface DevicePreferencesView {
  deviceId: string;
  revision: number;
  overrides: Partial<SettingsView['settings']>;
  effective: SettingsView['settings'];
  accountRevision: number;
  updatedAt: string | null;
}

/** A live favorite from GET /v1/me/favorites; `revision` is what a change must name to apply. */
export interface Favorite {
  entityId: string;
  revision: number;
  stationId: string;
  order: number;
  updatedAt: string;
}

/** A published station from the public catalog (GET /v1/catalog/radio). The web page never plays it. */
export interface CatalogStation {
  id: string;
  name: string;
  country: string;
  language: string;
  genres: string[];
  codec: string;
  bitrateKbps: number | null;
}

export type ProState = 'verified' | 'pending' | 'revoked' | 'none';

/** Per-change result of POST /v1/sync/push. */
export type SyncResult =
  | { changeId: string; entityId: string; status: 'applied'; revision: number }
  | { changeId: string; entityId: string; status: 'conflict'; reason: string; existingEntityId?: string }
  | { changeId: string; entityId: string; status: 'rejected'; reason: string };

export interface DevicesView {
  settingsRevision: number;
  serverObservedAt?: string;
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
}

export type RightsState = 'current' | 'missing' | 'territory' | 'not_yet_valid' | 'expired';

/** The draft country's rights from the station's rights records, and until when the apps may see the station. */
export interface StationRights {
  state: RightsState;
  expiresAt: string | null;
  reference: string | null;
  /** End of the public catalog's rights window (ISO time); null means no end. Only meaningful once published. */
  liveUntil: string | null;
}

/** One rights record (GET /v1/admin/stations/{id}/rights). Evidence keys are private storage keys, staff-only. */
export interface RightsRecord {
  id: string;
  holder: string;
  basis: string;
  reference: string;
  territories: string[];
  validFrom: string;
  expiresAt: string | null;
  status: 'active' | 'revoked';
  effectiveStatus: 'active' | 'scheduled' | 'expired' | 'revoked';
  evidenceCount: number;
  evidenceRefs?: string[];
  createdBy: string | null;
  createdAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

/** One entry of a station's version history (station.* and rights.* audit events). */
export interface StationHistoryEntry {
  id: string;
  occurredAt: string;
  action: string;
  actor: string;
  actorSubject: string | null;
  reason: string | null;
  revision: number | null;
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
  rights: StationRights;
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
/** At most 2,000 stations on one admin page. */
const STATION_PAGES_MAX = 20;
const STATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Deletion tickets: 32 random bytes, base64url. */
const DELETION_TICKET = /^[A-Za-z0-9_-]{43}$/;
const EXPORT_LINK = /^\/v1\/export-downloads\/[A-Za-z0-9_-]{43}$/;

export interface SupportGrant {
  id: string;
  grantedAt: string;
  expiresAt: string;
}
export interface SupportReports {
  access: SupportGrant;
  retentionDays: number;
  reports: Array<{
    id: string;
    receivedAt: string;
    platform: string | null;
    eventCount: number;
    items: Array<{ eventName: string; monotonicMs: number; durationMs: number | null; resultCode: string | null; networkClass: string; appBuild: string; osMajor: number; deviceClass: string }>;
  }>;
}

export type ExportStatus = 'pending' | 'ready' | 'failed';
export interface ExportJob {
  id: string;
  status: ExportStatus;
  requestedAt: string;
  readyAt: string | null;
  expiresAt: string;
}
/** The API's export job without its download link: the browser downloads through the BFF instead. */
const exportView = (v: ExportJob): ExportJob => ({ id: v.id, status: v.status, requestedAt: v.requestedAt, readyAt: v.readyAt, expiresAt: v.expiresAt });
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
  traceId: string | null;
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
export type OverviewWindow = '1h' | '24h' | '7d';
export type IncidentCode =
  | 'api_error_rate'
  | 'api_latency'
  | 'stations_suspect'
  | 'station_checker_stale'
  | 'station_rights_expiring'
  | 'account_deletion_failed'
  | 'account_deletion_stuck'
  | 'account_deletion_late'
  | 'account_export_stuck'
  | 'idp_session_end_stuck'
  | 'job_dead_letter'
  | 'no_recent_traffic';
/** GET /v1/admin/overview: aggregates only, with sample sizes and a stale flag (Doc 17). */
export interface Overview {
  window: { id: OverviewWindow; from: string; to: string };
  generatedAt: string;
  api: {
    requests: number;
    serverErrors: number;
    clientErrors: number;
    errorRate: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    lastRequestAt: string | null;
    stale: boolean;
    buckets: { at: string; requests: number; serverErrors: number; p95Ms: number | null }[];
    topErrors: { route: string; status: number; count: number }[];
  };
  stations: {
    published: number;
    disabled: number;
    health: Record<'ok' | 'failing' | 'suspect' | 'unknown', number>;
    checkerEnabled: boolean;
    lastCheckAt: string | null;
  };
  queues: {
    accountDeletions: { open: number; failed: number; oldestRequestedAt: string | null; deadlineDays: number };
    diagnosticReports: number;
  };
  /** Opt-in app diagnostics in the window; a failure is an event with a resultCode. Counts only. */
  clients: {
    reports: number;
    devices: number;
    events: number;
    byEvent: { eventName: string; events: number; failures: number; devices: number }[];
    topFailures: { eventName: string; resultCode: string; count: number; devices: number }[];
    builds: { appBuild: string; platform: 'ios' | 'android'; events: number; failures: number }[];
  };
  incidents: { code: IncidentCode; severity: 'critical' | 'warning'; count: number; since?: string }[];
}

/** GET /v1/admin/jobs (Doc 17 /admin/jobs): every background queue. Ids are opaque; no user ids. */
export type JobKind = 'account_deletion' | 'account_export' | 'idp_session_end';
export type JobStatus = 'pending' | 'retrying' | 'dead_letter' | 'completed';
export type JobFilter = 'open' | 'failed' | 'dead_letter' | 'completed' | 'all';
export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  requestedAt: string;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  /** A short code only (e.g. IDP_DELETE_FAILED), never a message. */
  lastErrorCode: string | null;
  completedAt: string | null;
  /** Account deletions only. */
  deadline: string | null;
}
export interface QueueSummary {
  kind: JobKind;
  pending: number;
  retrying: number;
  deadLetter: number;
  oldestOpenAt: string | null;
}
export interface JobsPage {
  jobs: Job[];
  counts: Record<JobStatus, number>;
  queues: QueueSummary[];
  truncated: boolean;
}
const JOB_ID = /^(?:[0-9a-f]{64}|ex_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|se_[0-9a-f]{64})$/;

/** GET /v1/admin/config (Doc 17 /admin/config): the draft, the current and recent releases. */
export type ConfigFeature = 'catalogBrowse' | 'playlistImport' | 'diagnosticsUpload';
export interface AppConfigPayload {
  minSupportedBuild: { ios: number | null; android: number | null };
  features: Record<ConfigFeature, boolean>;
  catalogRefreshHours: number;
}
/** Which apps a release is for (Doc 17 platform and build targeting). */
export type ConfigTargets = Record<'ios' | 'android', { include: boolean; minBuild: number | null; maxBuild: number | null }>;
export interface ConfigRelease {
  release: number;
  schemaVersion: number;
  environment: 'staging' | 'production';
  targets: ConfigTargets;
  config: AppConfigPayload;
  stagedRelease: number | null;
  reviewed: boolean;
  emergency: boolean;
  rollbackOf: number | null;
  draftRevision: number | null;
  publishedAt: string;
  expiresAt: string;
  reason: string;
  publishedByYou: boolean;
}
export interface AdminConfigView {
  draft: { config: AppConfigPayload; targets: ConfigTargets; revision: number; updatedAt: string | null; changedSinceRelease: string[] };
  current: ConfigRelease | null;
  staged: ConfigRelease | null;
  stagedIsDraft: boolean;
  stageBlockers: string[];
  releases: ConfigRelease[];
  publishBlockers: string[];
  defaults: AppConfigPayload;
  signingKeyId: string;
}

/** POST /v1/admin/users/lookup (Doc 17 support lookup): no settings values, stations or roles. */
export interface UserSupportView {
  matchedBy: 'user' | 'device' | 'email';
  user: { id: string; email: string | null; emailVerified: boolean; status: 'active' | 'deleting' | 'deleted' | 'disabled'; createdAt: string; deletedAt: string | null };
  settings: { revision: number; updatedAt: string | null };
  devices: {
    id: string;
    platform: 'ios' | 'android';
    osMajor: number;
    appBuild: string;
    appliedSettingsRevision: number;
    inSync: boolean;
    createdAt: string;
    lastSeenAt: string;
    revokedAt: string | null;
  }[];
  /** `access`: this staff member's running access to the reports, from the customer's code. */
  diagnostics: { reportsLast7Days: number; access: { id: string; expiresAt: string } | null };
  deletion: { status: 'pending' | 'failed' | 'dead_letter' | 'completed'; requestedAt: string } | null;
}

export interface AuditPage {
  events: AuditEvent[];
  nextCursor: string | null;
}
/** Search fields the console forwards to GET /v1/admin/audit; anything else is dropped. The API validates values. */
export const AUDIT_PARAMS = ['from', 'to', 'actor', 'action', 'targetType', 'targetId', 'requestId', 'includeReads', 'limit', 'cursor'] as const;

/** Search fields the console forwards to GET /v1/admin/logs; anything else is dropped. The API validates values. */
export const LOG_PARAMS = ['from', 'to', 'severity', 'service', 'build', 'eventCode', 'requestId', 'traceId', 'errorCode', 'status', 'limit', 'cursor'] as const;

/** The W3C trace of the BFF request being served; API calls made while serving it join that trace. */
const traceScope = new AsyncLocalStorage<{ traceId: string }>();
/** The language picked with the switch before sign-in (lang.ts LANG_COOKIE), for the provider's pages. */
const visitorLang = (req: Request) => (readCookie(req.headers.get('cookie'), 'td_lang') === 'en' ? 'en' : 'th');

const newTraceId = () => randomBytes(16).toString('hex');
/** `traceparent` for one API call: the current trace (a new one outside a BFF request) and a fresh span id. */
const traceparent = () => `00-${traceScope.getStore()?.traceId ?? newTraceId()}-${randomBytes(8).toString('hex')}-01`;

const LOGIN_TX_SECONDS = 600;
/** Clock skew allowed between the IdP and the console when checking a re-authentication's auth_time. */
const REAUTH_SKEW_SECONDS = 30;
const REFRESH_SKEW_MS = 30_000;
const MAX_BODY_BYTES = 16 * 1024;

export function createBff(deps: BffDeps) {
  const { config, oidc, store } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = createLogger(deps.logWriter, { environment: config.environment, build: config.build });
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
    // Continue a valid traceparent from the browser, else start the trace here; the API joins it.
    const traceId = traceIdFrom(req.headers.get('traceparent')) ?? newTraceId();
    const started = Date.now();
    let res: Response;
    try {
      res = await traceScope.run({ traceId }, () => run(requestId));
    } catch {
      res = error(503, 'UPSTREAM_UNAVAILABLE', requestId);
    }
    log(res.status >= 500 ? 'ERROR' : res.status >= 400 ? 'WARN' : 'INFO', {
      eventCode: 'BFF_REQUEST',
      requestId,
      traceId,
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
        headers: { ...init.headers, authorization: `Bearer ${token}`, 'x-request-id': requestId, traceparent: traceparent(), accept: 'application/json' },
        body: init.body,
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (res.status !== 401) return res;
      // A step-up demand is not an expired token: hand it back without refreshing or ending the session.
      const code = (await res.clone().json().catch(() => null))?.code;
      if (code === 'REAUTH_REQUIRED' || code === 'MFA_REQUIRED') return res;
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
    // A 204 or 304 must not carry a body, even an empty string.
    return new Response(upstream.status === 204 || upstream.status === 304 ? null : body, {
      status: upstream.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-request-id': requestId, ...headers },
    });
  }

  async function markStaffAtLogin(id: string, session: Session): Promise<void> {
    const res = await fetchImpl(`${config.apiBaseUrl}/v1/me/staff`, {
      headers: { authorization: `Bearer ${session.tokens.accessToken}`, accept: 'application/json', 'x-request-id': `web_${randomUUID()}`, traceparent: traceparent() },
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    });
    if (!res.ok) return;
    const { roles, rolesVersion } = (await res.json()) as { roles: StaffRole[]; rolesVersion?: string };
    if (roles.length > 0 || rolesVersion !== undefined) {
      if (roles.length > 0) session.staff = true;
      session.staffVersion = rolesVersion;
      await store.update(id, session);
    }
  }

  /** Reads the caller's staff roles and marks the session as a staff session when there are any. */
  async function loadStaff(ctx: SessionContext): Promise<{ roles: StaffRole[]; mfa: boolean } | { status: number } | null> {
    const res = await callApi(ctx, '/v1/me/staff', { method: 'GET' }, `web_${randomUUID()}`);
    if (!res) return null;
    if (!res.ok) return { status: res.status };
    const { roles, mfa, rolesVersion } = (await res.json()) as { roles: StaffRole[]; mfa?: boolean; rolesVersion?: string };
    // Doc 17: a role granted or revoked since this session started ends the session; the person signs in again.
    if (ctx.session.staffVersion !== undefined && rolesVersion !== undefined && rolesVersion !== ctx.session.staffVersion) {
      await store.delete(ctx.id);
      return null;
    }
    if ((roles.length > 0 && !ctx.session.staff) || (rolesVersion !== undefined && ctx.session.staffVersion === undefined)) {
      if (roles.length > 0) ctx.session.staff = true;
      ctx.session.staffVersion = rolesVersion;
      await store.update(ctx.id, ctx.session);
    }
    return { roles, mfa: mfa !== false };
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

  /**
   * A staff CSV export: the search in the page's query string (only `params`, no paging) and `{ reason }` in the
   * JSON body. The API checks the role, MFA and the row bound, and records the export with its reason.
   */
  const csvExport = (req: Request, route: string, apiPath: string, params: readonly string[], fallbackName: string) =>
    timed(req, route, async (requestId) => {
      const ctx = await sessionFromCookie(req.headers.get('cookie'));
      if (!ctx) return error(401, 'SESSION_EXPIRED', requestId);
      if (!csrfOk(req, ctx)) return error(403, 'CSRF_REJECTED', requestId);
      if (!req.headers.get('content-type')?.startsWith('application/json')) return error(415, 'UNSUPPORTED_MEDIA_TYPE', requestId);
      const body = await req.text();
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) return error(413, 'PAYLOAD_TOO_LARGE', requestId);
      const incoming = new URL(req.url).searchParams;
      const qs = new URLSearchParams();
      for (const k of params) {
        const v = incoming.get(k);
        if (k !== 'cursor' && k !== 'limit' && v && v.length <= 200) qs.set(k, v);
      }
      const upstream = await callApi(ctx, `${apiPath}?${qs}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, requestId);
      if (!upstream) return error(401, 'SESSION_EXPIRED', requestId, { 'set-cookie': clearCookie(names.session, secure) });
      if (!upstream.ok) return passthrough(upstream, requestId);
      const disposition = upstream.headers.get('content-disposition') ?? '';
      return new Response(await upstream.arrayBuffer(), {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'cache-control': 'no-store',
          'x-request-id': requestId,
          'content-disposition': /^attachment; filename="[\w.-]{1,64}"$/.test(disposition) ? disposition : `attachment; filename="${fallbackName}"`,
        },
      });
    });

  const notFound = (requestId: string) =>
    json(404, { code: 'NOT_FOUND', messageKey: 'errors.request.notFound', requestId, details: {} }, requestId);

  return {
    names,
    sessionFromCookie,
    loadStaff,

    /** Server-side read for staff pages: list (no id) or one station. Null means the user must sign in again. */
    async loadStations(ctx: SessionContext): Promise<{ status: number; stations?: AdminStation[] } | null> {
      // The API pages by 100 at most (Doc 17); the catalog screens show the whole list, so follow the pages.
      const stations: AdminStation[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < STATION_PAGES_MAX; page++) {
        const qs = `?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await callApi(ctx, `/v1/admin/stations${qs}`, { method: 'GET' }, `web_${randomUUID()}`);
        if (!res) return null;
        if (!res.ok) return { status: res.status };
        const body = (await res.json()) as { stations: AdminStation[]; nextCursor?: string | null };
        stations.push(...body.stations);
        cursor = body.nextCursor ?? null;
        if (!cursor) break;
      }
      return { status: 200, stations };
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

    /** Server-side read for /admin/overview. Null means the user must sign in again. */
    async loadOverview(ctx: SessionContext, window: string): Promise<{ status: number; overview?: Overview } | null> {
      const w = ['1h', '24h', '7d'].includes(window) ? window : '24h';
      const res = await callApi(ctx, `/v1/admin/overview?window=${w}`, { method: 'GET' }, `web_${randomUUID()}`);
      if (!res) return null;
      return res.ok ? { status: 200, overview: (await res.json()) as Overview } : { status: res.status };
    },

    /** Server-side read for /admin/jobs. Null means the user must sign in again. */
    async loadJobs(ctx: SessionContext, filter: string): Promise<{ status: number; page?: JobsPage } | null> {
      const f = ['open', 'failed', 'dead_letter', 'completed', 'all'].includes(filter) ? filter : 'open';
      const res = await callApi(ctx, `/v1/admin/jobs?status=${f}`, { method: 'GET' }, `web_${randomUUID()}`);
      if (!res) return null;
      return res.ok ? { status: 200, page: (await res.json()) as JobsPage } : { status: res.status };
    },

    /** POST /bff/admin/jobs/{id}/retry with `{ reason }`; the API checks the role, the cooldown and ceiling, and records it. */
    jobRetry: (req: Request, id: string) =>
      timed(req, '/bff/admin/jobs/:id/retry', async (requestId) =>
        JOB_ID.test(id) ? adminProxy(req, requestId, `/v1/admin/jobs/${id}/retry`, true) : notFound(requestId),
      ),

    /** Server-side read for /admin/config. Null means the user must sign in again. */
    async loadConfig(ctx: SessionContext): Promise<{ status: number; view?: AdminConfigView } | null> {
      const res = await callApi(ctx, '/v1/admin/config', { method: 'GET' }, `web_${randomUUID()}`);
      if (!res) return null;
      return res.ok ? { status: 200, view: (await res.json()) as AdminConfigView } : { status: res.status };
    },

    /** PATCH /bff/admin/config/draft (If-Match), POST …/publish (If-Match) and …/releases/{n}/rollback; the API checks roles. */
    configDraft: (req: Request) => timed(req, '/bff/admin/config/draft', (requestId) => adminProxy(req, requestId, '/v1/admin/config/draft', true)),
    configPublish: (req: Request) => timed(req, '/bff/admin/config/publish', (requestId) => adminProxy(req, requestId, '/v1/admin/config/publish', true)),
    /** POST /bff/admin/config/stage (If-Match): the draft goes to the staging channel first (Doc 17). */
    configStage: (req: Request) => timed(req, '/bff/admin/config/stage', (requestId) => adminProxy(req, requestId, '/v1/admin/config/stage', true)),
    configRollback: (req: Request, release: string) =>
      timed(req, '/bff/admin/config/releases/:release/rollback', async (requestId) =>
        /^[1-9]\d{0,14}$/.test(release) ? adminProxy(req, requestId, `/v1/admin/config/releases/${release}/rollback`, true) : notFound(requestId),
      ),

    /** POST /bff/admin/users/lookup with `{ query, reason }`; the API checks the role and records the lookup. */
    userLookup: (req: Request) => timed(req, '/bff/admin/users/lookup', (requestId) => adminProxy(req, requestId, '/v1/admin/users/lookup', true)),

    /** POST /bff/admin/users/{id}/diagnostics/access `{ code, reason }`: support enters the customer's code. */
    supportRedeem: (req: Request, userId: string) =>
      timed(req, '/bff/admin/users/:id/diagnostics/access', (requestId) =>
        DEVICE_ID.test(userId) ? adminProxy(req, requestId, `/v1/admin/users/${userId}/diagnostics/access`, true) : Promise.resolve(notFound(requestId)),
      ),

    /** GET /bff/admin/users/{id}/diagnostics: the customer's reports, for the support member they gave access to. */
    supportReports: (req: Request, userId: string) =>
      timed(req, '/bff/admin/users/:id/diagnostics', (requestId) =>
        DEVICE_ID.test(userId) ? adminProxy(req, requestId, `/v1/admin/users/${userId}/diagnostics`, false) : Promise.resolve(notFound(requestId)),
      ),

    /** GET or PUT /bff/devices/{id}/preferences: one device's overrides (PUT forwards If-Match). */
    devicePreferences: (req: Request, id: string) =>
      timed(req, '/bff/devices/:id/preferences', (requestId) =>
        DEVICE_ID.test(id) ? adminProxy(req, requestId, `/v1/me/devices/${id}/preferences`, req.method === 'PUT') : Promise.resolve(notFound(requestId)),
      ),

    /** GET /bff/support-access: the accesses this customer has given support. */
    mySupportAccess: (req: Request) => timed(req, '/bff/support-access', (requestId) => adminProxy(req, requestId, '/v1/me/support-access', false)),

    /** POST /bff/support-access/codes: a one-time code to read out to support. */
    supportCode: (req: Request) => timed(req, '/bff/support-access/codes', (requestId) => adminProxy(req, requestId, '/v1/me/support-access/codes', true)),

    /** DELETE /bff/support-access/{id}: the customer withdraws an access. */
    revokeSupportAccess: (req: Request, id: string) =>
      timed(req, '/bff/support-access/:id', (requestId) => (DEVICE_ID.test(id) ? adminProxy(req, requestId, `/v1/me/support-access/${id}`, true) : Promise.resolve(notFound(requestId)))),

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
    auditExport: (req: Request) => csvExport(req, '/bff/admin/audit/export', '/v1/admin/audit/export', AUDIT_PARAMS, 'tunedeck-audit.csv'),

    /** POST /bff/admin/logs/export: the current log search as CSV (Doc 17 log export), with `{ reason }` and recent MFA. */
    logExport: (req: Request) => csvExport(req, '/bff/admin/logs/export', '/v1/admin/logs/export', LOG_PARAMS, 'tunedeck-logs.csv'),

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

    /** GET/POST /bff/admin/stations/{id}/rights */
    stationRights: (req: Request, id: string) =>
      timed(req, '/bff/admin/stations/:id/rights', (requestId) =>
        STATION_ID.test(id) ? adminProxy(req, requestId, `/v1/admin/stations/${id}/rights`, req.method === 'POST') : Promise.resolve(notFound(requestId)),
      ),

    /** POST /bff/admin/stations/{id}/rights/{recordId}/revoke with `{ reason }` */
    stationRightsRevoke: (req: Request, id: string, recordId: string) =>
      timed(req, '/bff/admin/stations/:id/rights/:recordId/revoke', (requestId) =>
        STATION_ID.test(id) && STATION_ID.test(recordId)
          ? adminProxy(req, requestId, `/v1/admin/stations/${id}/rights/${recordId}/revoke`, true)
          : Promise.resolve(notFound(requestId)),
      ),

    /** GET /bff/admin/stations/{id}/history?cursor=&limit= (only those two, checked before they reach the API path) */
    stationHistory: (req: Request, id: string) =>
      timed(req, '/bff/admin/stations/:id/history', (requestId) => {
        if (!STATION_ID.test(id)) return Promise.resolve(notFound(requestId));
        const incoming = new URL(req.url).searchParams;
        const qs = new URLSearchParams();
        const cursor = incoming.get('cursor');
        const limit = incoming.get('limit');
        if (cursor && /^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) qs.set('cursor', cursor);
        if (limit && /^\d{1,3}$/.test(limit)) qs.set('limit', limit);
        return adminProxy(req, requestId, `/v1/admin/stations/${id}/history${qs.size ? `?${qs}` : ''}`, false);
      }),

    /**
     * GET /auth/login — starts authorization code + PKCE; the destination is limited to /app/ paths.
     * `reauth=1` makes the provider ask for credentials again, for actions that need a recent sign-in;
     * `mfa=1` also asks for the MFA level, for staff actions the API guards with a recent-MFA check.
     * `register=1` opens the provider's sign-up form instead of the sign-in form.
     */
    login: (req: Request) =>
      timed(req, '/auth/login', async () => {
        const params = new URL(req.url).searchParams;
        const returnTo = safeReturnTo(params.get('returnTo'));
        const mfa = params.get('mfa') === '1';
        const reauth = mfa || params.get('reauth') === '1';
        const tx = {
          state: randomToken(),
          nonce: randomToken(),
          codeVerifier: randomToken(48),
          returnTo,
          exp: Date.now() + LOGIN_TX_SECONDS * 1000,
          ...(reauth ? { reauthSince: Math.floor(Date.now() / 1000) } : {}),
        };
        const register = params.get('register') === '1';
        const url = await oidc.authorizeUrl({ ...tx, reauth, mfa, register, locale: visitorLang(req) });
        return redirect(url, 302, [
          serializeCookie(names.tx, sealTransaction(tx, config.sessionSecret), { secure, maxAgeSeconds: LOGIN_TX_SECONDS }),
        ]);
      }),

    /** GET /auth/recover — hands over to the provider's password reset; no email ever passes through the console. */
    recover: (req: Request) => timed(req, '/auth/recover', async () => redirect(oidc.passwordResetUrl(visitorLang(req)), 302)),

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

    /** Server-side read of GET /v1/me: the account id customers give support. Null means sign in again. */
    async loadMe(ctx: SessionContext): Promise<{ status: number; userId?: string } | null> {
      const res = await callApi(ctx, '/v1/me', { method: 'GET' }, `web_${randomUUID()}`);
      if (!res) return null;
      return res.ok ? { status: 200, userId: ((await res.json()) as { userId: string }).userId } : { status: res.status };
    },

    /** Server-side read of the account's devices for the settings page. Null means the user must sign in again. */
    async loadDevices(ctx: SessionContext): Promise<{ status: number; view?: DevicesView } | null> {
      const res = await callApi(ctx, '/v1/me/devices?limit=100', { method: 'GET' }, `web_${randomUUID()}`);
      if (!res) return null;
      return res.ok ? { status: 200, view: (await res.json()) as DevicesView } : { status: res.status };
    },

    /** Server-side read of the account's live favorites for /app/radio and /app/overview. Null means sign in again. */
    async loadFavorites(ctx: SessionContext): Promise<{ status: number; favorites?: Favorite[] } | null> {
      const res = await callApi(ctx, '/v1/me/favorites', { method: 'GET' }, `web_${randomUUID()}`);
      if (!res) return null;
      return res.ok ? { status: 200, favorites: ((await res.json()) as { favorites: Favorite[] }).favorites } : { status: res.status };
    },

    /** Server-side read of the account's Pro state per store (store-scoped in R1). Null means sign in again. */
    async loadEntitlements(ctx: SessionContext): Promise<{ status: number; pro?: Record<'apple' | 'google', ProState> } | null> {
      const res = await callApi(ctx, '/v1/me/entitlements', { method: 'GET' }, `web_${randomUUID()}`);
      if (!res) return null;
      return res.ok ? { status: 200, pro: ((await res.json()) as { pro: Record<'apple' | 'google', ProState> }).pro } : { status: res.status };
    },

    /** Server-side read of the public catalog, up to 500 stations. No session needed: the catalog is public. */
    async loadCatalog(): Promise<{ status: number; stations?: CatalogStation[]; truncated?: boolean }> {
      const stations: CatalogStation[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const res = await fetchImpl(`${config.apiBaseUrl}/v1/catalog/radio?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {
          headers: { accept: 'application/json', 'x-request-id': `web_${randomUUID()}`, traceparent: traceparent() },
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        });
        if (!res.ok) return { status: res.status };
        const body = (await res.json()) as { stations: (CatalogStation & { streamUrl?: string })[]; nextCursor: string | null };
        // The stream address is not needed on the web page, so it never reaches the browser.
        for (const { id, name, country, language, genres, codec, bitrateKbps } of body.stations) stations.push({ id, name, country, language, genres, codec, bitrateKbps });
        cursor = body.nextCursor;
        if (!cursor) return { status: 200, stations };
      }
      return { status: 200, stations, truncated: true };
    },

    /** Whether the API answers its readiness probe, for the service line on /app/overview. */
    async serviceReady(): Promise<boolean> {
      try {
        const res = await fetchImpl(`${config.apiBaseUrl}/health/ready`, { signal: AbortSignal.timeout(3_000), redirect: 'error' });
        return res.ok;
      } catch {
        return false;
      }
    },

    /** GET /bff/favorites: the page reloads the list after a change or a conflict. */
    getFavorites: (req: Request) =>
      timed(req, '/bff/favorites', async (requestId) => {
        const ctx = await sessionFromCookie(req.headers.get('cookie'));
        if (!ctx) return error(401, 'SESSION_EXPIRED', requestId);
        const upstream = await callApi(ctx, '/v1/me/favorites', { method: 'GET' }, requestId);
        if (!upstream) return error(401, 'SESSION_EXPIRED', requestId, { 'set-cookie': clearCookie(names.session, secure) });
        return passthrough(upstream, requestId);
      }),

    /** POST /bff/sync/push: favorites changes made on the web, through the same sync the phones use. */
    pushSync: (req: Request) =>
      timed(req, '/bff/sync/push', async (requestId) => {
        const ctx = await sessionFromCookie(req.headers.get('cookie'));
        if (!ctx) return error(401, 'SESSION_EXPIRED', requestId);
        if (!csrfOk(req, ctx)) return error(403, 'CSRF_REJECTED', requestId);
        if (!req.headers.get('content-type')?.startsWith('application/json')) return error(415, 'UNSUPPORTED_MEDIA_TYPE', requestId);
        const body = await req.text();
        if (Buffer.byteLength(body) > MAX_BODY_BYTES) return error(413, 'PAYLOAD_TOO_LARGE', requestId);
        const upstream = await callApi(ctx, '/v1/sync/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body }, requestId);
        if (!upstream) return error(401, 'SESSION_EXPIRED', requestId, { 'set-cookie': clearCookie(names.session, secure) });
        return passthrough(upstream, requestId);
      }),

    /** Server-side read of the account's own diagnostic reports for /app/privacy. Null means sign in again. */
    async loadDiagnostics(ctx: SessionContext): Promise<{ status: number; view?: DiagnosticsView } | null> {
      const res = await callApi(ctx, '/v1/me/diagnostics?limit=100', { method: 'GET' }, `web_${randomUUID()}`);
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
        const upstream = await callApi(ctx, '/v1/me/devices?limit=100', { method: 'GET' }, requestId);
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

    /**
     * POST /bff/account/exports: starts building the account's data export (Doc 17). Needs a recent sign-in,
     * like deletion; the page polls GET /bff/account/exports/{id} and then downloads through /file.
     */
    startExport: (req: Request) =>
      timed(req, '/bff/account/exports', async (requestId) => {
        const ctx = await sessionFromCookie(req.headers.get('cookie'));
        if (!ctx) return error(401, 'SESSION_EXPIRED', requestId);
        if (!csrfOk(req, ctx)) return error(403, 'CSRF_REJECTED', requestId);
        // One key per click: the page sends it, so a retried click is the same request (Doc 17 requires one here).
        const sent = req.headers.get('idempotency-key');
        const key = sent && /^[A-Za-z0-9_.:-]{8,128}$/.test(sent) ? sent : randomUUID();
        const upstream = await callApi(ctx, '/v1/me/exports', { method: 'POST', headers: { 'idempotency-key': key } }, requestId);
        if (!upstream) return error(401, 'SESSION_EXPIRED', requestId, { 'set-cookie': clearCookie(names.session, secure) });
        if (upstream.status !== 202) return passthrough(upstream, requestId);
        return json(202, exportView(await upstream.json()), requestId);
      }),

    /** GET /bff/account/exports/{id}: progress. The API's download link stays on the server. */
    exportStatus: (req: Request, id: string) =>
      timed(req, '/bff/account/exports/:id', async (requestId) => {
        if (!DEVICE_ID.test(id)) return notFound(requestId);
        const ctx = await sessionFromCookie(req.headers.get('cookie'));
        if (!ctx) return error(401, 'SESSION_EXPIRED', requestId);
        const upstream = await callApi(ctx, `/v1/me/exports/${id}`, { method: 'GET' }, requestId);
        if (!upstream) return error(401, 'SESSION_EXPIRED', requestId, { 'set-cookie': clearCookie(names.session, secure) });
        if (!upstream.ok) return passthrough(upstream, requestId);
        return json(200, exportView(await upstream.json()), requestId);
      }),

    /** GET /bff/account/exports/{id}/file: fetches a fresh 15-minute link from the API and streams the file through. */
    exportFile: (req: Request, id: string) =>
      timed(req, '/bff/account/exports/:id/file', async (requestId) => {
        if (!DEVICE_ID.test(id)) return notFound(requestId);
        const ctx = await sessionFromCookie(req.headers.get('cookie'));
        if (!ctx) return error(401, 'SESSION_EXPIRED', requestId);
        const upstream = await callApi(ctx, `/v1/me/exports/${id}/link`, { method: 'POST' }, requestId);
        if (!upstream) return error(401, 'SESSION_EXPIRED', requestId, { 'set-cookie': clearCookie(names.session, secure) });
        if (!upstream.ok) return passthrough(upstream, requestId);
        const path = ((await upstream.json()) as { path?: unknown }).path;
        if (typeof path !== 'string' || !EXPORT_LINK.test(path)) return notFound(requestId);
        const file = await fetchImpl(`${config.apiBaseUrl}${path}`, {
          headers: { accept: 'application/json', 'x-request-id': requestId },
          signal: AbortSignal.timeout(30_000),
          redirect: 'error',
        });
        if (!file.ok) return passthrough(file, requestId);
        const disposition = file.headers.get('content-disposition') ?? '';
        return new Response(file.body, {
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
