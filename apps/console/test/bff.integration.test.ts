import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBff, Bff } from '@/lib/bff';
import { ConsoleConfig } from '@/lib/config';
import { readCookie } from '@/lib/cookies';
import { OidcClient } from '@/lib/oidc';
import { MemorySessionStore } from '@/lib/session';
import { ApiProcess, startApi } from './api-process';
import { CLIENT_ID, CLIENT_SECRET, MockIdp, startMockIdp } from './mock-idp';

const BASE = 'http://localhost:3200';
let idp: MockIdp;
let api: ApiProcess;
let clock = Date.now();
let logs: string[];
let bff: Bff;

function config(): ConsoleConfig {
  return {
    baseUrl: BASE,
    apiBaseUrl: api.url,
    oidc: { issuer: idp.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, scopes: 'openid', algorithms: ['RS256'] },
    sessionSecret: 'x'.repeat(40),
    secureCookies: false,
    sessionIdleMs: 12 * 3600_000,
    sessionAbsoluteMs: 7 * 24 * 3600_000,
    sessionDatabaseUrl: null,
    environment: 'dev',
    build: 'console-test',
  };
}

const setCookies = (res: Response) => res.headers.getSetCookie();
const cookieValue = (res: Response, name: string) => {
  const c = setCookies(res).find((s) => s.startsWith(`${name}=`));
  return c ? c.split(';')[0].slice(name.length + 1) : undefined;
};

/** Plays the browser through login: BFF → IdP → BFF callback. Returns the session cookie header. */
async function signIn(user: string, via: Bff = bff): Promise<string> {
  idp.setUser(user);
  const start = await via.login(new Request(`${BASE}/auth/login?returnTo=/app/settings`));
  expect(start.status).toBe(302);
  const tx = cookieValue(start, 'td_login')!;
  const atIdp = await fetch(start.headers.get('location')!, { redirect: 'manual' });
  const callback = await via.callback(new Request(atIdp.headers.get('location')!, { headers: { cookie: `td_login=${tx}` } }));
  expect(callback.status).toBe(302);
  expect(callback.headers.get('location')).toBe('/app/settings');
  return `td_session=${cookieValue(callback, 'td_session')}`;
}

async function csrfFor(cookie: string): Promise<string> {
  const ctx = await bff.sessionFromCookie(cookie);
  return ctx!.session.csrfToken;
}

const get = (cookie: string) => bff.getSettings(new Request(`${BASE}/bff/settings`, { headers: { cookie } }));
const patch = (cookie: string, body: unknown, o: { csrf?: string; ifMatch?: string; origin?: string } = {}) =>
  bff.patchSettings(
    new Request(`${BASE}/bff/settings`, {
      method: 'PATCH',
      headers: {
        cookie,
        'content-type': 'application/json',
        ...(o.origin !== '' ? { origin: o.origin ?? BASE } : {}),
        ...(o.csrf ? { 'x-csrf-token': o.csrf } : {}),
        ...(o.ifMatch ? { 'if-match': o.ifMatch } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

beforeAll(async () => {
  idp = await startMockIdp();
  api = await startApi(idp.issuer);
  logs = [];
  bff = createBff({
    config: config(),
    oidc: new OidcClient(config()),
    store: new MemorySessionStore(12 * 3600_000, 7 * 24 * 3600_000, () => clock),
    logWriter: (l) => logs.push(l),
  });
});

afterAll(async () => {
  await api?.stop();
  await idp?.close();
});

describe('login', () => {
  it('starts with PKCE S256, state and nonce, and keeps the transaction in an HttpOnly cookie', async () => {
    const res = await bff.login(new Request(`${BASE}/auth/login`));
    const url = new URL(res.headers.get('location')!);
    expect(url.origin).toBe(idp.issuer);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toHaveLength(43);
    expect(url.searchParams.get('nonce')).toHaveLength(43);
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE}/auth/callback`);
    const tx = setCookies(res).find((c) => c.startsWith('td_login='))!;
    expect(tx).toMatch(/HttpOnly/);
    expect(tx).toMatch(/SameSite=Lax/);
    expect(tx).toMatch(/Max-Age=600/);
  });

  it('creates a session cookie that holds only an opaque id', async () => {
    const cookie = await signIn('alice-login');
    const id = cookie.split('=')[1];
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const token of idp.issued) expect(token).not.toContain(id);
  });

  it.each(['https://evil.example/app', '//evil.example/app/x', '/administrator', '/app/\\evil'])(
    'never redirects after login to %s',
    async (returnTo) => {
      idp.setUser('alice-redirect');
      const start = await bff.login(new Request(`${BASE}/auth/login?returnTo=${encodeURIComponent(returnTo)}`));
      const tx = cookieValue(start, 'td_login')!;
      const atIdp = await fetch(start.headers.get('location')!, { redirect: 'manual' });
      const cb = await bff.callback(new Request(atIdp.headers.get('location')!, { headers: { cookie: `td_login=${tx}` } }));
      expect(cb.headers.get('location')).toBe('/app/home');
    },
  );

  it('rejects a callback whose state does not match', async () => {
    const start = await bff.login(new Request(`${BASE}/auth/login`));
    const tx = cookieValue(start, 'td_login')!;
    const atIdp = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    const forged = new URL(atIdp.headers.get('location')!);
    forged.searchParams.set('state', 'A'.repeat(43));
    const cb = await bff.callback(new Request(forged, { headers: { cookie: `td_login=${tx}` } }));
    expect(cb.headers.get('location')).toBe('/login?error=signin');
    expect(cookieValue(cb, 'td_session')).toBeUndefined();
  });

  it('rejects a callback without the login cookie (login CSRF) and a replayed code', async () => {
    const start = await bff.login(new Request(`${BASE}/auth/login`));
    const tx = cookieValue(start, 'td_login')!;
    const atIdp = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    const cbUrl = atIdp.headers.get('location')!;
    expect((await bff.callback(new Request(cbUrl))).headers.get('location')).toBe('/login?error=signin');
    const ok = await bff.callback(new Request(cbUrl, { headers: { cookie: `td_login=${tx}` } }));
    expect(ok.headers.get('location')).toBe('/app/home');
    const replay = await bff.callback(new Request(cbUrl, { headers: { cookie: `td_login=${tx}` } }));
    expect(replay.headers.get('location')).toBe('/login?error=signin');
  });

  it('replaces any session id the browser had before login', async () => {
    const old = await signIn('alice-fixation');
    const start = await bff.login(new Request(`${BASE}/auth/login`));
    const tx = cookieValue(start, 'td_login')!;
    const atIdp = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    const cb = await bff.callback(new Request(atIdp.headers.get('location')!, { headers: { cookie: `td_login=${tx}; ${old}` } }));
    expect(cookieValue(cb, 'td_session')).not.toBe(old.split('=')[1]);
    expect((await get(old)).status).toBe(401);
  });
});

describe('settings through the BFF and the real API', () => {
  it('reads defaults, saves with CSRF and If-Match, and reloads the saved revision', async () => {
    const cookie = await signIn('alice-save');
    const first = await get(cookie);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ revision: 0, settings: { theme: 'system', language: 'th' } });

    const saved = await patch(cookie, { theme: 'dark' }, { csrf: await csrfFor(cookie), ifMatch: '"0"' });
    expect(saved.status).toBe(200);
    expect(saved.headers.get('etag')).toBe('"1"');

    const reloaded = await (await get(cookie)).json();
    expect(reloaded).toMatchObject({ revision: 1, settings: { theme: 'dark' } });
  });

  it('keeps two accounts apart', async () => {
    const alice = await signIn('alice-iso');
    const bob = await signIn('bob-iso');
    await patch(alice, { language: 'en' }, { csrf: await csrfFor(alice), ifMatch: '"0"' });
    const bobView = await (await get(bob)).json();
    expect(bobView).toMatchObject({ revision: 0, settings: { language: 'th' } });
    // Bob's CSRF token is useless with Alice's session.
    expect((await patch(alice, { theme: 'light' }, { csrf: await csrfFor(bob), ifMatch: '"1"' })).status).toBe(403);
  });

  it('passes a stale save through as 412 with the current revision', async () => {
    const cookie = await signIn('alice-stale');
    const csrf = await csrfFor(cookie);
    await patch(cookie, { theme: 'dark' }, { csrf, ifMatch: '"0"' });
    const stale = await patch(cookie, { theme: 'light' }, { csrf, ifMatch: '"0"' });
    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({ code: 'REVISION_MISMATCH', details: { currentRevision: 1 } });
  });

  it('passes an invalid value through as 400', async () => {
    const cookie = await signIn('alice-invalid');
    const res = await patch(cookie, { theme: 'cockpit' }, { csrf: await csrfFor(cookie), ifMatch: '"0"' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });
});

describe('devices through the BFF and the real API', () => {
  const devices = (cookie: string) => bff.getDevices(new Request(`${BASE}/bff/devices`, { headers: { cookie } }));

  it('lists only the signed-in account\'s devices, with their applied revision', async () => {
    const cookie = await signIn('bff-devices');
    const empty = await devices(cookie);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ settingsRevision: 0, devices: [], serverObservedAt: expect.any(String), nextCursor: null });

    const phone = await idp.accessTokenFor('bff-devices');
    const put = await fetch(`${api.url}/v1/me/devices/0b9a4f8e-6c1d-4e2a-9f3b-1a2b3c4d5e6f`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${phone}`, 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'android', osMajor: 15, appBuild: '1.0.0+7', appliedSettingsRevision: 0 }),
    });
    expect(put.status).toBe(200);

    const listed = await (await devices(cookie)).json();
    expect(listed.devices).toHaveLength(1);
    expect(listed.devices[0]).toMatchObject({ platform: 'android', appliedSettingsRevision: 0, overrides: {}, preferencesRevision: 0 });
    expect((await (await devices(await signIn('bff-devices-other'))).json()).devices).toEqual([]);
  });

  it('returns 401 SESSION_EXPIRED without a session', async () => {
    expect((await devices('')).status).toBe(401);
  });
});

describe('favorites through the BFF and the real API', () => {
  const push = (cookie: string, body: unknown, csrf?: string) =>
    bff.pushSync(
      new Request(`${BASE}/bff/sync/push`, {
        method: 'POST',
        headers: { cookie, origin: BASE, 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
        body: JSON.stringify(body),
      }),
    );
  const change = () => ({ changeId: crypto.randomUUID(), entityId: crypto.randomUUID(), type: 'favorite', op: 'upsert', baseRevision: 0, value: { stationId: crypto.randomUUID(), order: 0 } });

  it('needs CSRF to change favorites and passes per-change results through', async () => {
    const cookie = await signIn('bff-favorites');
    expect((await push(cookie, { changes: [change()] })).status).toBe(403);
    const res = await push(cookie, { changes: [change()] }, await csrfFor(cookie));
    expect(res.status).toBe(200);
    expect((await res.json()).results[0]).toMatchObject({ status: 'rejected', reason: 'unknown_station' });
    const list = await bff.getFavorites(new Request(`${BASE}/bff/favorites`, { headers: { cookie } }));
    expect(await list.json()).toEqual({ favorites: [] });
    expect((await push('', { changes: [change()] })).status).toBe(401);
  });

  it('serves the catalog to the page without stream addresses', async () => {
    const catalog = await bff.loadCatalog();
    expect(catalog.status).toBe(200);
    for (const s of catalog.stations ?? []) expect(s).not.toHaveProperty('streamUrl');
  });
});

describe('staff routes through the BFF', () => {
  const station = {
    name: 'BFF FM', country: 'TH', language: 'th', genres: [], streamUrl: 'https://stream.example.com/bff.mp3', codec: 'mp3',
  };
  const record = { holder: 'BFF Media', basis: 'owner_permission', reference: 'REF-1', territories: ['TH'], evidenceRefs: ['rights/bff.pdf'] };
  const rightsPost = (cookie: string, id: string, body: unknown, csrf?: string, recordId?: string) => {
    const path = recordId ? `/bff/admin/stations/${id}/rights/${recordId}/revoke` : `/bff/admin/stations/${id}/rights`;
    const req = new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: BASE, ...(csrf ? { 'x-csrf-token': csrf } : {}) },
      body: JSON.stringify(body),
    });
    return recordId ? bff.stationRightsRevoke(req, id, recordId) : bff.stationRights(req, id);
  };
  const post = (cookie: string, path: string, body: unknown, o: { csrf?: string; origin?: string; ifMatch?: string } = {}) => {
    const req = new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: o.origin ?? BASE, ...(o.csrf ? { 'x-csrf-token': o.csrf } : {}), ...(o.ifMatch ? { 'if-match': o.ifMatch } : {}) },
      body: JSON.stringify(body),
    });
    const [, , , , id, action] = path.split('/');
    return id ? bff.stationAction(req, id, action) : bff.stations(req);
  };

  beforeAll(() => {
    api.staff('grant', 'bff-editor', 'catalog_editor', '--by', 'test', '--reason', 'test');
    api.staff('grant', 'bff-admin', 'admin', '--by', 'test', '--reason', 'test');
  });

  it('lets an editor create and an admin publish, with CSRF required on every change', async () => {
    const editor = await signIn('bff-editor');
    expect((await post(editor, '/bff/admin/stations', station)).status).toBe(403);
    expect((await post(editor, '/bff/admin/stations', station, { csrf: await csrfFor(editor), origin: 'https://evil.example' })).status).toBe(403);
    const created = await post(editor, '/bff/admin/stations', station, { csrf: await csrfFor(editor) });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect((await rightsPost(editor, id, record)).status).toBe(403);
    expect((await rightsPost(editor, id, record, await csrfFor(editor))).status).toBe(201);

    const admin = await signIn('bff-admin');
    const listed = await bff.stations(new Request(`${BASE}/bff/admin/stations`, { headers: { cookie: admin } }));
    expect((await listed.json()).stations.map((s: { id: string }) => s.id)).toContain(id);
    const published = await post(admin, `/bff/admin/stations/${id}/publish`, { reason: 'ok' }, { csrf: await csrfFor(admin), ifMatch: '"1"' });
    expect(published.status).toBe(200);
    expect((await published.json()).status).toBe('published');
  });

  it('searches stations on the server and reads the catalog counts in one call', async () => {
    const editor = await signIn('bff-editor');
    const csrf = await csrfFor(editor);
    for (const name of ['Search Probe Alpha', 'search probe beta']) expect((await post(editor, '/bff/admin/stations', { ...station, name }, { csrf })).status).toBe(201);
    const ctx = (await bff.sessionFromCookie(editor))!;
    const found = await bff.loadStations(ctx, { q: 'SEARCH PROBE' });
    expect(found).toMatchObject({ status: 200, truncated: false });
    expect(found!.stations!.map((s) => s.draft.name)).toEqual(['Search Probe Alpha', 'search probe beta']);
    const all = await bff.loadStations(ctx);
    const counts = await bff.loadStationSummary(ctx);
    expect(counts).toMatchObject({ status: 200 });
    expect(counts!.summary!.total).toBe(all!.stations!.length);
    expect(counts!.summary!.drafts).toBe(all!.stations!.filter((s) => s.status === 'draft').length);
    const customer = await signIn('bff-search-customer');
    expect(await bff.loadStationSummary((await bff.sessionFromCookie(customer))!)).toEqual({ status: 403 });
  });

  it('manages rights records and reads the station history through the BFF', async () => {
    const editor = await signIn('bff-editor');
    const csrf = await csrfFor(editor);
    const { id } = await (await post(editor, '/bff/admin/stations', { ...station, name: 'BFF Rights FM' }, { csrf })).json();
    const added = await rightsPost(editor, id, record, csrf);
    expect(added.status).toBe(201);
    const rec = await added.json();
    expect(rec).not.toHaveProperty('evidenceRefs');

    const list = await bff.stationRights(new Request(`${BASE}/bff/admin/stations/${id}/rights`, { headers: { cookie: editor } }), id);
    expect((await list.json()).records[0]).toMatchObject({ id: rec.id, evidenceRefs: ['rights/bff.pdf'] });

    expect((await rightsPost(editor, id, { reason: 'owner withdrew permission' }, undefined, rec.id)).status).toBe(403);
    const revoked = await rightsPost(editor, id, { reason: 'owner withdrew permission' }, csrf, rec.id);
    expect((await revoked.json()).status).toBe('revoked');

    const history = await bff.stationHistory(new Request(`${BASE}/bff/admin/stations/${id}/history?limit=2&evil=1`, { headers: { cookie: editor } }), id);
    const body = await history.json();
    expect(body.events.map((e: { action: string }) => e.action)).toEqual(['rights.revoke', 'rights.add']);
    expect(body.nextCursor).toEqual(expect.any(String));
    const next = await bff.stationHistory(new Request(`${BASE}/bff/admin/stations/${id}/history?cursor=${body.nextCursor}`, { headers: { cookie: editor } }), id);
    expect((await next.json()).events.map((e: { action: string }) => e.action)).toEqual(['station.create']);

    // Ids are checked before they reach an API path.
    expect((await bff.stationHistory(new Request(`${BASE}/bff/admin/stations/x/history`, { headers: { cookie: editor } }), '../../me')).status).toBe(404);
    expect((await rightsPost(editor, id, { reason: 'x' }, csrf, '../revoke')).status).toBe(404);
    expect((await bff.stationRights(new Request(`${BASE}/bff/admin/stations/x/rights`, { headers: { cookie: editor } }), 'x')).status).toBe(404);
  });

  it('ends the web session when a staff role is granted or revoked after sign-in (Doc 17)', async () => {
    api.staff('grant', 'bff-role-change', 'support', '--by', 'test', '--reason', 'test');
    const cookie = await signIn('bff-role-change');
    const ctx = await bff.sessionFromCookie(cookie);
    expect(await bff.loadStaff(ctx!)).toEqual({ roles: ['support'], mfa: true, mfaChanged: false });
    api.staff('revoke', 'bff-role-change', 'support', '--by', 'test', '--reason', 'test');
    expect(await bff.loadStaff((await bff.sessionFromCookie(cookie))!)).toBeNull();
    expect(await bff.sessionFromCookie(cookie)).toBeNull();
  });

  it('passes the API refusal through for accounts without a staff role', async () => {
    const customer = await signIn('bff-customer');
    expect((await bff.stations(new Request(`${BASE}/bff/admin/stations`, { headers: { cookie: customer } }))).status).toBe(403);
  });

  it('never builds an API path from an unchecked id or action', async () => {
    const admin = await signIn('bff-admin');
    const csrf = await csrfFor(admin);
    expect((await bff.station(new Request(`${BASE}/bff/admin/stations/x`, { headers: { cookie: admin } }), '../../me/settings')).status).toBe(404);
    expect((await post(admin, '/bff/admin/stations/0b9a4f8e-6c1d-4e2a-9f3b-1a2b3c4d5e6f/delete', {}, { csrf })).status).toBe(404);
  });

  it('gives staff accounts the 30-minute idle limit from sign-in', async () => {
    const admin = await signIn('bff-admin');
    expect((await bff.sessionFromCookie(admin))!.session.staff).toBe(true);
    const customer = await signIn('bff-customer-2');
    expect((await bff.sessionFromCookie(customer))!.session.staff).toBeFalsy();
    clock += 31 * 60_000;
    expect(await bff.sessionFromCookie(admin)).toBeNull();
    expect(await bff.sessionFromCookie(customer)).not.toBeNull();
  });
});

describe('CSRF', () => {
  let cookie: string;
  beforeAll(async () => {
    cookie = await signIn('alice-csrf');
  });

  it('rejects a save without the CSRF token', async () => {
    const res = await patch(cookie, { theme: 'dark' }, { ifMatch: '"0"' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('CSRF_REJECTED');
  });

  it('rejects a save from another origin even with the token', async () => {
    expect((await patch(cookie, { theme: 'dark' }, { csrf: await csrfFor(cookie), ifMatch: '"0"', origin: 'https://evil.example' })).status).toBe(403);
  });

  it('rejects a save with no Origin header', async () => {
    expect((await patch(cookie, { theme: 'dark' }, { csrf: await csrfFor(cookie), ifMatch: '"0"', origin: '' })).status).toBe(403);
  });

  it('rejects a non-JSON body', async () => {
    const res = await bff.patchSettings(
      new Request(`${BASE}/bff/settings`, {
        method: 'PATCH',
        headers: { cookie, origin: BASE, 'x-csrf-token': await csrfFor(cookie), 'content-type': 'text/plain', 'if-match': '"0"' },
        body: 'theme=dark',
      }),
    );
    expect(res.status).toBe(415);
  });

  it('keeps logout from being triggered by another site', async () => {
    const res = await bff.logout(
      new Request(`${BASE}/auth/logout`, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf=nope' }),
    );
    expect(res.headers.get('location')).toBe('/app/settings?error=csrf');
    expect((await get(cookie)).status).toBe(200);
  });
});

describe('session lifetime', () => {
  it('returns 401 SESSION_EXPIRED without a session', async () => {
    const res = await get('');
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('SESSION_EXPIRED');
  });

  it('ends a session after 12 hours idle', async () => {
    const cookie = await signIn('alice-idle');
    clock += 12 * 3600_000 + 1;
    try {
      expect((await get(cookie)).status).toBe(401);
    } finally {
      clock = Date.now();
    }
  });

  it('refreshes an expired access token transparently with refresh rotation', async () => {
    idp.setAccessTtl(-60); // the login hands out an already-expired access token
    const cookie = await signIn('alice-refresh');
    idp.setAccessTtl(300);
    const res = await get(cookie);
    expect(res.status).toBe(200);
  });

  it('shares one refresh between parallel requests of the same session (each refresh token works once)', async () => {
    idp.setAccessTtl(-60);
    const cookie = await signIn('alice-parallel');
    idp.setAccessTtl(300);
    const answers = await Promise.all(Array.from({ length: 5 }, () => get(cookie)));
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect((await get(cookie)).status).toBe(200);
  });

  it('ends the session when the refresh token is no longer valid', async () => {
    idp.setAccessTtl(-60);
    const cookie = await signIn('alice-revoked');
    idp.revokeRefreshTokens();
    idp.setAccessTtl(300);
    const res = await get(cookie);
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toMatch(/td_session=;.*Max-Age=0/);
    expect((await get(cookie)).status).toBe(401);
  });

  it('logs out locally and at the IdP', async () => {
    const cookie = await signIn('alice-logout');
    const res = await bff.logout(
      new Request(`${BASE}/auth/logout`, {
        method: 'POST',
        headers: { cookie, origin: BASE, 'content-type': 'application/x-www-form-urlencoded' },
        body: `csrf=${encodeURIComponent(await csrfFor(cookie))}`,
      }),
    );
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get('location')!);
    expect(to.origin + to.pathname).toBe(`${idp.issuer}/logout`);
    expect(to.searchParams.get('post_logout_redirect_uri')).toBe(`${BASE}/login?signedOut=1`);
    expect(res.headers.get('set-cookie')).toMatch(/td_session=;.*Max-Age=0/);
    expect((await get(cookie)).status).toBe(401);
  });
});

describe('upstream failures and logging', () => {
  it('returns 503 when the API is unreachable', async () => {
    const down = createBff({
      config: { ...config(), apiBaseUrl: 'http://127.0.0.1:1' },
      oidc: new OidcClient(config()),
      store: new MemorySessionStore(3600_000, 3600_000),
      logWriter: () => undefined,
    });
    idp.setUser('alice-down');
    const start = await down.login(new Request(`${BASE}/auth/login`));
    const tx = cookieValue(start, 'td_login')!;
    const atIdp = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    const cb = await down.callback(new Request(atIdp.headers.get('location')!, { headers: { cookie: `td_login=${tx}` } }));
    const cookie = `td_session=${cookieValue(cb, 'td_session')}`;
    const res = await down.getSettings(new Request(`${BASE}/bff/settings`, { headers: { cookie } }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('never writes tokens, codes or session ids to the log', async () => {
    const raw = logs.join('');
    expect(raw.length).toBeGreaterThan(0);
    for (const secret of idp.issued) expect(raw).not.toContain(secret);
    expect(raw).not.toMatch(/td_session=|code=|Bearer /);
    const line = JSON.parse(logs[0]);
    expect(Object.keys(line).sort()).toEqual(['build', 'durationMs', 'environment', 'eventCode', 'method', 'requestId', 'route', 'service', 'severity', 'status', 'timestamp', 'traceId']);
    expect(line).toMatchObject({ environment: 'dev', build: 'console-test', traceId: expect.stringMatching(/^[0-9a-f]{32}$/) });
  });
});

describe('trace context through the BFF', () => {
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const sent: string[] = [];
  const lines: string[] = [];
  let traced: Bff;

  beforeAll(() => {
    traced = createBff({
      config: config(),
      oidc: new OidcClient(config()),
      store: new MemorySessionStore(12 * 3600_000, 7 * 24 * 3600_000, () => clock),
      logWriter: (l) => lines.push(l),
      fetchImpl: async (input, init) => {
        if (String(input).startsWith(api.url)) sent.push(new Headers(init?.headers).get('traceparent') ?? '');
        return fetch(input, init);
      },
    });
  });

  it('starts a trace per request, sends it to the API and finds the API line under the same trace id', async () => {
    const cookie = await signIn('trace-user', traced);
    sent.length = 0;
    lines.length = 0;
    expect((await traced.getSettings(new Request(`${BASE}/bff/settings`, { headers: { cookie } }))).status).toBe(200);
    const line = JSON.parse(lines[lines.length - 1]);
    expect(line).toMatchObject({ eventCode: 'BFF_REQUEST', route: '/bff/settings', traceId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(sent.length).toBeGreaterThan(0);
    for (const h of sent) expect(h).toMatch(new RegExp(`^00-${line.traceId}-[0-9a-f]{16}-01$`));
    // The API keeps its request line under the same trace (written to the database within about a second).
    let rows: { route: string }[] = [];
    for (let i = 0; i < 40 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      rows = ((await api.sql(`SELECT route FROM operational_logs WHERE trace_id = '${line.traceId}'`)) as { rows: { route: string }[] }).rows;
    }
    expect(rows.map((r) => r.route)).toContain('/v1/me/settings');
  });

  it('continues a valid traceparent from the browser and ignores an invalid one', async () => {
    const cookie = await signIn('trace-user-2', traced);
    sent.length = 0;
    lines.length = 0;
    await traced.getSettings(new Request(`${BASE}/bff/settings`, { headers: { cookie, traceparent: `00-${TRACE}-00f067aa0ba902b7-01` } }));
    expect(JSON.parse(lines[lines.length - 1]).traceId).toBe(TRACE);
    expect(sent.every((h) => h.startsWith(`00-${TRACE}-`) && !h.includes('00f067aa0ba902b7'))).toBe(true);
    lines.length = 0;
    await traced.getSettings(new Request(`${BASE}/bff/settings`, { headers: { cookie, traceparent: `00-${'0'.repeat(32)}-00f067aa0ba902b7-01` } }));
    expect(JSON.parse(lines[lines.length - 1]).traceId).not.toMatch(/^0+$/);
  });
});

describe('log export through the BFF', () => {
  const exportReq = (cookie: string, csrf: string, qs: string, body: unknown = { reason: 'incident review for ticket 42' }) =>
    bff.logExport(
      new Request(`${BASE}/bff/admin/logs/export?${qs}`, {
        method: 'POST',
        headers: { cookie, origin: BASE, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  beforeAll(() => {
    api.staff('grant', 'bff-ops', 'operator', '--by', 'test', '--reason', 'test');
  });

  it('downloads the current search as CSV, forwarding only search fields, and the API records the reason', async () => {
    const ops = await signIn('bff-ops');
    const csrf = await csrfFor(ops);
    const to = new Date();
    const from = new Date(to.getTime() - 3600_000);
    const qs = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), severity: 'INFO', traceId: 'a'.repeat(32), errorCode: 'X_FAILED', limit: '10', cursor: 'abc', other: 'drop' });
    const res = await exportReq(ops, csrf, qs.toString());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="tunedeck-logs-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect((await res.text()).replace(/^\uFEFF/, '').split('\r\n')[0]).toContain('traceId');
    const audit = (await api.sql(`SELECT reason, changes FROM audit_events WHERE action = 'logs.export' ORDER BY id DESC LIMIT 1`)) as { rows: { reason: string; changes: Record<string, unknown> }[] };
    expect(audit.rows[0].reason).toBe('incident review for ticket 42');
    expect(audit.rows[0].changes).toMatchObject({ traceId: 'a'.repeat(32), errorCode: 'X_FAILED', severity: ['INFO'], rows: 0 });
  });

  it('needs CSRF and passes the API refusals through', async () => {
    const ops = await signIn('bff-ops');
    expect((await exportReq(ops, 'wrong', '')).status).toBe(403);
    const short = await exportReq(ops, await csrfFor(ops), '', { reason: 'short' });
    expect(short.status).toBe(400);
    expect((await short.json()).details.field).toBe('reason');
    const customer = await signIn('bff-customer-logs');
    expect((await exportReq(customer, await csrfFor(customer), '')).status).toBe(403);
  });
});

it('readCookie ignores lookalike cookie names', () => {
  expect(readCookie('xtd_session=a; td_session=b', 'td_session')).toBe('b');
});

describe('register and recover (Doc 17)', () => {
  it('opens the provider\'s sign-up form with the usual PKCE and state, and hands password reset to the provider', async () => {
    const start = await bff.login(new Request(`${BASE}/auth/login?register=1`));
    const url = new URL(start.headers.get('location')!);
    expect(url.searchParams.get('prompt')).toBe('create');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
    const plain = new URL((await bff.login(new Request(`${BASE}/auth/login`))).headers.get('location')!);
    expect(plain.searchParams.has('prompt')).toBe(false);

    const recover = await bff.recover(new Request(`${BASE}/auth/recover`));
    expect(recover.status).toBe(302);
    const reset = new URL(recover.headers.get('location')!);
    expect(reset.pathname).toMatch(/\/login-actions\/reset-credentials$/);
    expect(reset.searchParams.get('client_id')).toBe(config().oidc.clientId);
  });

  it('opens the provider\'s pages in the language picked before sign-in, Thai by default', async () => {
    const th = new URL((await bff.login(new Request(`${BASE}/auth/login?register=1`))).headers.get('location')!);
    expect(th.searchParams.get('ui_locales')).toBe('th');
    const en = new URL((await bff.login(new Request(`${BASE}/auth/login`, { headers: { cookie: 'td_lang=en' } }))).headers.get('location')!);
    expect(en.searchParams.get('ui_locales')).toBe('en');
    const reset = new URL((await bff.recover(new Request(`${BASE}/auth/recover`, { headers: { cookie: 'td_lang=en' } }))).headers.get('location')!);
    expect(reset.searchParams.get('kc_locale')).toBe('en');
  });
});

describe('MFA step-up for staff actions', () => {
  it('asks the provider for a fresh sign-in at the MFA level, and only with mfa=1', async () => {
    const withAcr = new OidcClient({ ...config(), oidc: { ...config().oidc, mfaAcr: 'gold' } });
    const mfa = new URL(await withAcr.authorizeUrl({ state: 's', nonce: 'n', codeVerifier: 'v'.repeat(48), mfa: true }));
    expect(mfa.searchParams.get('acr_values')).toBe('gold');
    expect(mfa.searchParams.get('prompt')).toBe('login');
    expect(mfa.searchParams.get('max_age')).toBe('0');
    const plain = new URL(await withAcr.authorizeUrl({ state: 's', nonce: 'n', codeVerifier: 'v'.repeat(48), reauth: true }));
    expect(plain.searchParams.has('acr_values')).toBe(false);

    const start = await bff.login(new Request(`${BASE}/auth/login?mfa=1&returnTo=${encodeURIComponent('/admin/config')}`));
    const url = new URL(start.headers.get('location')!);
    expect(url.searchParams.get('max_age')).toBe('0');
    // No OIDC_MFA_ACR configured here: still a forced sign-in, without acr_values.
    expect(url.searchParams.has('acr_values')).toBe(false);
  });
  it('passes the API\'s MFA_REQUIRED through without refreshing or ending the session', async () => {
    // The test API runs without STAFF_MFA_ACR, so the MFA answer is staged on the BFF's way to the API.
    let apiCalls = 0;
    const store = new MemorySessionStore(12 * 3600_000, 7 * 24 * 3600_000, () => clock);
    const stepUp = createBff({
      config: config(),
      oidc: new OidcClient(config()),
      store,
      logWriter: () => undefined,
      fetchImpl: async (input, init) => {
        if (String(input).includes('/v1/admin/audit/export')) {
          apiCalls++;
          return Response.json({ code: 'MFA_REQUIRED', messageKey: 'errors.auth.mfaRequired', details: { maxAgeSeconds: 300 } }, { status: 401 });
        }
        return fetch(input, init);
      },
    });
    const cookie = await signIn('mfa-auditor', stepUp);
    const ctx = await stepUp.sessionFromCookie(cookie);
    const res = await stepUp.auditExport(
      new Request(`${BASE}/bff/admin/audit/export`, {
        method: 'POST',
        headers: { cookie, origin: BASE, 'x-csrf-token': ctx!.session.csrfToken, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'quarterly review of changes' }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('MFA_REQUIRED');
    expect(apiCalls).toBe(1);
    expect(await stepUp.sessionFromCookie(cookie)).not.toBeNull();
  });
});

describe('device sign-out with re-authentication', () => {
  const DEVICE = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';
  const revoke = (cookie: string, csrf: string | undefined, id = DEVICE) =>
    bff.revokeDevice(
      new Request(`${BASE}/bff/devices/${id}/session`, {
        method: 'DELETE',
        headers: { cookie, origin: BASE, ...(csrf ? { 'x-csrf-token': csrf } : {}) },
      }),
      id,
    );
  /** Plays a ?reauth=1 login through the IdP; returns the callback response. */
  async function reauth(cookie: string, returnTo: string) {
    const start = await bff.login(new Request(`${BASE}/auth/login?reauth=1&returnTo=${encodeURIComponent(returnTo)}`));
    const url = new URL(start.headers.get('location')!);
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('max_age')).toBe('0');
    const atIdp = await fetch(url, { redirect: 'manual' });
    return bff.callback(new Request(atIdp.headers.get('location')!, { headers: { cookie: `${cookie}; td_login=${cookieValue(start, 'td_login')}` } }));
  }
  async function registerPhone(user: string) {
    const res = await fetch(`${api.url}/v1/me/devices/${DEVICE}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${await idp.accessTokenFor(user)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'android', osMajor: 15, appBuild: '1.0.0+42', appliedSettingsRevision: 0 }),
    });
    expect(res.status).toBe(200);
  }

  it('asks for a fresh sign-in without ending the session, then signs the phone out', async () => {
    await registerPhone('rv-alice');
    await signIn('rv-alice');
    idp.ageSignIn(600);
    const stale = await signIn('rv-alice'); // the SSO session is reused, so auth_time is 10 minutes old
    const first = await revoke(stale, await csrfFor(stale));
    expect(first.status).toBe(401);
    expect((await first.json()).code).toBe('REAUTH_REQUIRED');
    expect(setCookies(first)).toEqual([]);
    expect((await get(stale)).status).toBe(200);

    const cb = await reauth(stale, `/app/devices?revoke=${DEVICE}`);
    expect(cb.headers.get('location')).toBe(`/app/devices?revoke=${DEVICE}`);
    const fresh = `td_session=${cookieValue(cb, 'td_session')}`;
    expect(fresh).not.toBe(stale);
    expect(await bff.sessionFromCookie(stale)).toBeNull();
    const done = await revoke(fresh, await csrfFor(fresh));
    expect(done.status).toBe(200);
    expect((await done.json()).revokedAt).not.toBeNull();
  });

  it('refuses a re-authentication the provider answered from its old SSO session', async () => {
    await signIn('rv-bob');
    idp.ageSignIn(600);
    idp.ignoreReauth(true);
    try {
      const stale = await signIn('rv-bob');
      const cb = await reauth(stale, `/app/devices?revoke=${DEVICE}`);
      expect(cb.headers.get('location')).toBe('/app/devices?reauth=failed');
      expect(cookieValue(cb, 'td_session')).toBeUndefined();
      expect((await get(stale)).status).toBe(200);
    } finally {
      idp.ignoreReauth(false);
    }
  });

  it('needs the CSRF token and a device id', async () => {
    const cookie = await signIn('rv-carol');
    expect((await revoke(cookie, undefined)).status).toBe(403);
    expect((await revoke(cookie, await csrfFor(cookie), 'not-a-device')).status).toBe(404);
    expect((await revoke('td_session=missing', 'x')).status).toBe(401);
  });
});

describe('account export and deletion', () => {
  const del = (cookie: string, csrf?: string) =>
    bff.deleteAccount(new Request(`${BASE}/bff/account`, { method: 'DELETE', headers: { cookie, origin: BASE, ...(csrf ? { 'x-csrf-token': csrf } : {}) } }));

  it('prepares the export after a fresh sign-in, and downloads it through the BFF without exposing the API link', async () => {
    const start = (cookie: string, csrf?: string) =>
      bff.startExport(new Request(`${BASE}/bff/account/exports`, { method: 'POST', headers: { cookie, origin: BASE, ...(csrf ? { 'x-csrf-token': csrf } : {}) } }));
    await signIn('acct-web-export-stale');
    idp.ageSignIn(600);
    const stale = await signIn('acct-web-export-stale');
    expect((await start(stale)).status).toBe(403);
    const refused = await start(stale, await csrfFor(stale));
    expect(refused.status).toBe(401);
    expect((await refused.json()).code).toBe('REAUTH_REQUIRED');
    expect(await bff.sessionFromCookie(stale)).not.toBeNull();

    const cookie = await signIn('acct-web-export');
    const res = await start(cookie, await csrfFor(cookie));
    expect(res.status).toBe(202);
    const job = await res.json();
    expect(job).toMatchObject({ status: 'pending' });

    let status = job;
    for (let i = 0; i < 50 && status.status === 'pending'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = await (await bff.exportStatus(new Request(`${BASE}/bff/account/exports/${job.id}`, { headers: { cookie } }), job.id)).json();
    }
    expect(status).toEqual({ id: job.id, status: 'ready', requestedAt: expect.any(String), readyAt: expect.any(String), expiresAt: expect.any(String) });

    const download = async (c: string, csrf?: string) =>
      bff.exportFile(
        new Request(`${BASE}/bff/account/exports/${job.id}/file`, {
          method: 'POST',
          headers: { cookie: c, origin: BASE, 'content-type': 'application/x-www-form-urlencoded' },
          body: csrf ? new URLSearchParams({ csrf }).toString() : '',
        }),
        job.id,
      );
    // It mints a link, so a cross-site page (no token) cannot trigger it.
    expect((await download(cookie)).status).toBe(403);
    const file = await download(cookie, await csrfFor(cookie));
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toMatch(/^attachment; filename="tunedeck-export-[\d-]+\.json"$/);
    expect((await file.json()).format).toBe('tunedeck-account-export');

    // Coming back to the button more than 5 minutes after signing in sends the browser to sign in again,
    // back to a fresh export, instead of showing an error page.
    idp.ageSignIn(600);
    const aged = await signIn('acct-web-export');
    const again = await download(aged, await csrfFor(aged));
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toBe(`/auth/login?reauth=1&returnTo=${encodeURIComponent('/app/privacy?export=1')}`);
    expect(await bff.sessionFromCookie(aged)).not.toBeNull();

    // Someone else's export, and malformed ids, are not found.
    const other = await signIn('acct-web-export-other');
    expect((await download(other, await csrfFor(other))).status).toBe(404);
    expect((await bff.exportStatus(new Request(`${BASE}/bff/account/exports/x`, { headers: { cookie } }), 'x')).status).toBe(404);
  });

  it('needs CSRF and a fresh sign-in, then ends the web session and hands back a ticket', async () => {
    await signIn('acct-web-delete');
    idp.ageSignIn(600);
    const stale = await signIn('acct-web-delete');
    expect((await del(stale)).status).toBe(403);
    const first = await del(stale, await csrfFor(stale));
    expect(first.status).toBe(401);
    expect((await first.json()).code).toBe('REAUTH_REQUIRED');
    expect(await bff.sessionFromCookie(stale)).not.toBeNull();

    const start = await bff.login(new Request(`${BASE}/auth/login?reauth=1&returnTo=${encodeURIComponent('/app/privacy?delete=1')}`));
    const atIdp = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    const cb = await bff.callback(new Request(atIdp.headers.get('location')!, { headers: { cookie: `${stale}; td_login=${cookieValue(start, 'td_login')}` } }));
    expect(cb.headers.get('location')).toBe('/app/privacy?delete=1');
    const fresh = `td_session=${cookieValue(cb, 'td_session')}`;

    const res = await del(fresh, await csrfFor(fresh));
    expect(res.status).toBe(202);
    const { ticket, status } = await res.json();
    expect(status).toBe('deleting');
    expect(setCookies(res).some((c) => c.startsWith('td_session=;'))).toBe(true);
    expect(await bff.sessionFromCookie(fresh)).toBeNull();

    // Progress needs no session; the purge runs right after the request.
    let body: { status: string } = { status: 'deleting' };
    for (let i = 0; i < 50 && body.status === 'deleting'; i++) {
      const s = await bff.deletionStatus(new Request(`${BASE}/bff/account-deletions/${ticket}`), ticket);
      expect(s.status).toBe(200);
      body = await s.json();
      if (body.status === 'deleting') await new Promise((r) => setTimeout(r, 100));
    }
    expect(body.status).toBe('completed');
    expect((await bff.deletionStatus(new Request(`${BASE}/bff/account-deletions/x`), 'x')).status).toBe(404);
  });
});

describe('world map stations', () => {
  it('takes the API map list in one call, splits a country by coordinates, shares one cached answer and needs a session', async () => {
    const asked: string[] = [];
    const station = (n: number, geo: boolean, country = 'TH') => ({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      name: `Map ${n}`,
      country,
      language: 'thai',
      genres: ['jazz'],
      codec: 'mp3',
      bitrateKbps: 128,
      streamUrl: `https://s${n}.example.test/live.mp3`,
      logoUrl: null,
      homepageUrl: null,
      ...(geo ? { geo: { lat: 13.75, lon: 100.5 } } : {}),
    });
    const mapped = createBff({
      config: config(),
      oidc: new OidcClient(config()),
      store: new MemorySessionStore(12 * 3600_000, 7 * 24 * 3600_000, () => clock),
      logWriter: () => undefined,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (!url.pathname.startsWith('/v1/directory/radio')) return fetch(input, init);
        asked.push(url.pathname + url.search);
        const stations =
          url.pathname === '/v1/directory/radio/map'
            ? url.searchParams.get('country')
              ? [station(1, true), station(2, false), station(3, true)]
              : [station(1, true), station(4, true, 'BR')]
            : url.searchParams.get('offset') === '0'
              ? [station(5, true, 'VN'), station(1, true)]
              : [];
        return new Response(JSON.stringify({ stations, attribution: 'Radio Browser' }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const req = (q: string, cookie?: string) => new Request(`${BASE}/bff/directory/map${q}`, { headers: cookie ? { cookie } : {} });
    expect((await mapped.getMapStations(req(''))).status).toBe(401);
    const cookie = await signIn('map-user', mapped);
    const res = await mapped.getMapStations(req('?country=th', cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stations: { name: string; lat: number; lon: number }[]; unmapped: { name: string; lat?: number }[] };
    expect(body.stations.map((s) => [s.name, s.lat, s.lon])).toEqual([
      ['Map 1', 13.75, 100.5],
      ['Map 3', 13.75, 100.5],
    ]);
    // The country's stations without coordinates are listed once, without a place.
    expect(body.unmapped.map((s) => [s.name, s.lat])).toEqual([['Map 2', undefined]]);
    expect(asked).toEqual(['/v1/directory/radio/map?country=TH']);
    expect((await mapped.getMapStations(req('?country=TH', cookie))).status).toBe(200);
    expect(asked).toHaveLength(1);
    expect((await mapped.getMapStations(req('?country=Thailand', cookie))).status).toBe(400);
    // Thailand is already in full in the world list, so a Thai viewer's world view is the plain world list.
    asked.length = 0;
    const world = (await (await mapped.getMapStations(req('?home=th', cookie))).json()) as { stations: { name: string }[]; unmapped: unknown[] };
    expect(asked).toEqual(['/v1/directory/radio/map']);
    expect(world.stations.map((s) => s.name)).toEqual(['Map 1', 'Map 4']);
    expect(world.unmapped).toEqual([]);
    // A viewer from elsewhere also gets two pages of their own country's mapped stations, first.
    asked.length = 0;
    const vn = (await (await mapped.getMapStations(req('?home=VN', cookie))).json()) as { stations: { name: string }[] };
    expect([...asked].sort()).toEqual(['/v1/directory/radio/map', ...[0, 50].map((o) => `/v1/directory/radio?limit=50&hasGeo=true&country=VN&offset=${o}`)].sort());
    expect(vn.stations.map((s) => s.name)).toEqual(['Map 5', 'Map 1', 'Map 4']);
    expect((await mapped.getMapStations(req('?home=xyz', cookie))).status).toBe(400);
  });
});

describe('a country’s most listened stations for the home page', () => {
  it('keeps Radio Browser’s order, takes logos from the map list, stands in with the map list when the search fails, and needs a session', async () => {
    const st = (n: number, extra: object = {}) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name: `Top ${n}`, country: 'TH', language: 'thai', genres: ['pop'], codec: 'mp3', bitrateKbps: 128, streamUrl: `https://t${n}.example.test/live.mp3`, logoUrl: null, homepageUrl: null, ...extra });
    let searchDown = false;
    const asked: string[] = [];
    const top = createBff({
      config: config(),
      oidc: new OidcClient(config()),
      store: new MemorySessionStore(12 * 3600_000, 7 * 24 * 3600_000, () => Date.now()),
      logWriter: () => undefined,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (!url.pathname.startsWith('/v1/directory/radio')) return fetch(input, init);
        asked.push(url.pathname + url.search);
        if (url.pathname === '/v1/directory/radio/map') return new Response(JSON.stringify({ stations: [st(3, { logoVersion: 'aaaaaaaaaaaa', geo: { lat: 13.7, lon: 100.5 } }), st(1), st(2, { logoVersion: 'bbbbbbbbbbbb' })] }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (searchDown) return new Response('{}', { status: 503 });
        // The search answers in listener order and carries no logo.
        return new Response(JSON.stringify({ stations: [st(2), st(9, { streamUrl: 'http://plain.example.test/x.mp3' }), st(3), st(1)] }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const req = (q: string, cookie?: string) => new Request(`${BASE}/bff/directory/top${q}`, { headers: cookie ? { cookie } : {} });
    expect((await top.getTopStations(req('?country=TH'))).status).toBe(401);
    const cookie = await signIn('top-user', top);
    expect((await top.getTopStations(req('', cookie))).status).toBe(400);
    expect((await top.getTopStations(req('?country=Thailand', cookie))).status).toBe(400);
    const res = await top.getTopStations(req('?country=th', cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stations: { name: string; logoVersion?: string }[] };
    expect(body.stations.map((s) => [s.name, s.logoVersion])).toEqual([['Top 2', 'bbbbbbbbbbbb'], ['Top 3', 'aaaaaaaaaaaa'], ['Top 1', undefined]]);
    expect([...asked].sort()).toEqual(['/v1/directory/radio/map?country=TH', '/v1/directory/radio?country=TH&limit=48']);
    // Kept in this process: the next viewer costs the API nothing.
    await top.getTopStations(req('?country=TH', cookie));
    expect(asked).toHaveLength(2);
    searchDown = true;
    const jp = (await (await top.getTopStations(req('?country=JP', cookie))).json()) as { stations: { name: string }[] };
    expect(jp.stations.map((s) => s.name)).toEqual(['Top 3', 'Top 1', 'Top 2']);
  });
});

describe('logos through the BFF and the real API', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(30, 5)]);
  const brandPost = async (cookie: string, body: unknown, remove = false) =>
    bff.brandLogo(
      new Request(`${BASE}/bff/admin/brand/station-logo${remove ? '/remove' : ''}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', origin: BASE, 'x-csrf-token': await csrfFor(cookie) },
        body: JSON.stringify(body),
      }),
      remove,
    );

  beforeAll(() => {
    api.staff('grant', 'bff-logo-admin', 'admin', '--by', 'test', '--reason', 'test');
  });

  it('always answers an image: TuneDeck’s built-in mark, then the logo admins upload', async () => {
    const unknown = await bff.stationLogo(new Request(`${BASE}/bff/logos/stations/00000000-0000-4000-8000-000000000001?v=abc`), '00000000-0000-4000-8000-000000000001');
    expect(unknown.status).toBe(200);
    expect(unknown.headers.get('content-type')).toBe('image/svg+xml');
    expect(unknown.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await unknown.text()).toContain('<svg');
    expect((await bff.stationLogo(new Request(`${BASE}/bff/logos/stations/x`), '../x')).headers.get('content-type')).toBe('image/svg+xml');

    const viewer = await signIn('bff-logo-viewer');
    expect((await brandPost(viewer, { contentType: 'image/png', data: PNG.toString('base64') })).status).toBe(403);
    const admin = await signIn('bff-logo-admin');
    expect((await brandPost(admin, { contentType: 'image/png', data: PNG.toString('base64') })).status).toBe(200);
    const brand = await bff.defaultLogo();
    expect(brand.headers.get('content-type')).toBe('image/png');
    expect(brand.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.compare(Buffer.from(await brand.arrayBuffer()), PNG)).toBe(0);
    expect((await brandPost(admin, {}, true)).status).toBe(204);
    expect((await bff.defaultLogo()).headers.get('content-type')).toBe('image/svg+xml');
  });
});
