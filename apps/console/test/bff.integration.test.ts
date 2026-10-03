import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBff, Bff } from '@/lib/bff';
import { ConsoleConfig } from '@/lib/config';
import { readCookie } from '@/lib/cookies';
import { OidcClient } from '@/lib/oidc';
import { MemorySessionStore } from '@/lib/session';
import { startApi } from './api-process';
import { CLIENT_ID, CLIENT_SECRET, MockIdp, startMockIdp } from './mock-idp';

const BASE = 'http://localhost:3200';
let idp: MockIdp;
let api: { url: string; stop: () => Promise<void> };
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
  };
}

const setCookies = (res: Response) => res.headers.getSetCookie();
const cookieValue = (res: Response, name: string) => {
  const c = setCookies(res).find((s) => s.startsWith(`${name}=`));
  return c ? c.split(';')[0].slice(name.length + 1) : undefined;
};

/** Plays the browser through login: BFF → IdP → BFF callback. Returns the session cookie header. */
async function signIn(user: string): Promise<string> {
  idp.setUser(user);
  const start = await bff.login(new Request(`${BASE}/auth/login?returnTo=/app/settings`));
  expect(start.status).toBe(302);
  const tx = cookieValue(start, 'td_login')!;
  const atIdp = await fetch(start.headers.get('location')!, { redirect: 'manual' });
  const callback = await bff.callback(new Request(atIdp.headers.get('location')!, { headers: { cookie: `td_login=${tx}` } }));
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

  it.each(['https://evil.example/app', '//evil.example/app/x', '/admin', '/app/\\evil'])(
    'never redirects after login to %s',
    async (returnTo) => {
      idp.setUser('alice-redirect');
      const start = await bff.login(new Request(`${BASE}/auth/login?returnTo=${encodeURIComponent(returnTo)}`));
      const tx = cookieValue(start, 'td_login')!;
      const atIdp = await fetch(start.headers.get('location')!, { redirect: 'manual' });
      const cb = await bff.callback(new Request(atIdp.headers.get('location')!, { headers: { cookie: `td_login=${tx}` } }));
      expect(cb.headers.get('location')).toBe('/app/settings');
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
    expect(ok.headers.get('location')).toBe('/app/settings');
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
    expect(await empty.json()).toEqual({ settingsRevision: 0, devices: [] });

    const phone = await idp.accessTokenFor('bff-devices');
    const put = await fetch(`${api.url}/v1/me/devices/0b9a4f8e-6c1d-4e2a-9f3b-1a2b3c4d5e6f`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${phone}`, 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'android', osMajor: 15, appBuild: '1.0.0+7', appliedSettingsRevision: 0 }),
    });
    expect(put.status).toBe(200);

    const listed = await (await devices(cookie)).json();
    expect(listed.devices).toHaveLength(1);
    expect(listed.devices[0]).toMatchObject({ platform: 'android', appliedSettingsRevision: 0 });
    expect((await (await devices(await signIn('bff-devices-other'))).json()).devices).toEqual([]);
  });

  it('returns 401 SESSION_EXPIRED without a session', async () => {
    expect((await devices('')).status).toBe(401);
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
    expect(Object.keys(line).sort()).toEqual(['durationMs', 'eventCode', 'method', 'requestId', 'route', 'service', 'severity', 'status', 'timestamp']);
  });
});

it('readCookie ignores lookalike cookie names', () => {
  expect(readCookie('xtd_session=a; td_session=b', 'td_session')).toBe('b');
});
