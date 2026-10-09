import { describe, expect, it } from 'vitest';
import { countByHealth, healthLine, logApiParams, logHref, logSearchFrom, rightsDaysLeft, rightsLine, rightsSoon, visibleInApps } from '@/lib/admin';
import type { AdminStation } from '@/lib/bff';
import { loadConfig } from '@/lib/config';
import { openTransaction, safeReturnTo, sealTransaction } from '@/lib/cookies';
import { createLogger, traceIdFrom } from '@/lib/log';
import { MemorySessionStore } from '@/lib/session';
import { langFrom, langFromAcceptLanguage } from '@/lib/lang';
import { accountLang } from '@/lib/i18n';

const env = {
  CONSOLE_BASE_URL: 'https://console.tunedeck.test',
  API_BASE_URL: 'http://api:3100',
  OIDC_ISSUER: 'https://idp/realms/t',
  OIDC_CLIENT_ID: 'c',
  OIDC_CLIENT_SECRET: 's',
  SESSION_SECRET: 'z'.repeat(32),
  SESSION_DATABASE_URL: 'postgres://console@db/tunedeck',
};

describe('config', () => {
  it('uses secure cookies outside localhost', () => {
    expect(loadConfig(env).secureCookies).toBe(true);
    expect(loadConfig({ ...env, CONSOLE_BASE_URL: 'http://localhost:3200' }).secureCookies).toBe(false);
  });
  it('refuses plain http outside localhost, short secrets and symmetric algorithms', () => {
    expect(() => loadConfig({ ...env, CONSOLE_BASE_URL: 'http://console.tunedeck.test' })).toThrow();
    expect(() => loadConfig({ ...env, SESSION_SECRET: 'short' })).toThrow();
    expect(() => loadConfig({ ...env, OIDC_ALGORITHMS: 'HS256' })).toThrow();
  });
  it('reads the MFA acr values for staff step-up', () => {
    expect(loadConfig(env).oidc.mfaAcr).toBeUndefined();
    expect(loadConfig({ ...env, OIDC_MFA_ACR: 'gold, 2' }).oidc.mfaAcr).toBe('gold 2');
    expect(() => loadConfig({ ...env, OIDC_MFA_ACR: 'a"b' })).toThrow('OIDC_MFA_ACR');
  });
  it('needs a shared session database outside localhost', () => {
    expect(() => loadConfig({ ...env, SESSION_DATABASE_URL: '' })).toThrow('SESSION_DATABASE_URL');
    expect(() => loadConfig({ ...env, SESSION_DATABASE_URL: 'redis://x' })).toThrow('SESSION_DATABASE_URL');
    expect(loadConfig({ ...env, SESSION_DATABASE_URL: '', CONSOLE_BASE_URL: 'http://localhost:3200' }).sessionDatabaseUrl).toBeNull();
  });
  it('reads the environment and build for log lines', () => {
    expect(loadConfig(env)).toMatchObject({ environment: 'unknown', build: 'unknown' });
    expect(loadConfig({ ...env, APP_ENV: 'staging', BUILD_VERSION: '1.4.0+52' })).toMatchObject({ environment: 'staging', build: '1.4.0+52' });
    expect(() => loadConfig({ ...env, APP_ENV: 'Prod "x"' })).toThrow('APP_ENV');
    expect(() => loadConfig({ ...env, BUILD_VERSION: 'a b' })).toThrow('BUILD_VERSION');
  });
});

describe('log lines and trace context', () => {
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  it('writes environment, build and trace id on each line', () => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l), { environment: 'staging', build: '1.4.0+52' })('INFO', {
      eventCode: 'BFF_REQUEST', requestId: 'web_1', traceId: TRACE, method: 'GET', route: '/bff/settings', status: 200, durationMs: 3,
    });
    expect(JSON.parse(lines[0])).toMatchObject({ service: 'console', environment: 'staging', build: '1.4.0+52', traceId: TRACE });
  });
  it('accepts only valid traceparent headers', () => {
    expect(traceIdFrom(`00-${TRACE}-00f067aa0ba902b7-01`)).toBe(TRACE);
    expect(traceIdFrom(`01-${TRACE}-00f067aa0ba902b7-01-later`)).toBe(TRACE);
    for (const bad of [null, '', 'x', `ff-${TRACE}-00f067aa0ba902b7-01`, `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`, `00-${TRACE}-${'0'.repeat(16)}-01`, `00-${TRACE.toUpperCase()}-00f067aa0ba902b7-01`, `00-${TRACE}-00f067aa0ba902b7-01-x`]) {
      expect(traceIdFrom(bad)).toBeNull();
    }
  });
});

describe('log search form', () => {
  it('keeps the window at 24 hours at most and passes traceId and errorCode on', () => {
    const s = logSearchFrom({ range: '7d', traceId: ' 4BF92F3577B34DA6A3CE929D0E0E4736 ', errorCode: 'IDP_DELETE_FAILED' });
    expect(s.range).toBe('1h');
    const p = logApiParams({ ...s, range: '24h' }, Date.parse('2026-10-04T12:00:00Z'));
    expect(p).toMatchObject({ from: '2026-10-03T12:00:00.000Z', to: '2026-10-04T12:00:00.000Z', traceId: '4bf92f3577b34da6a3ce929d0e0e4736', errorCode: 'IDP_DELETE_FAILED', limit: '50' });
    expect(logHref({ traceId: 'abc', range: '24h' })).toBe('/admin/logs?traceId=abc&range=24h');
  });
});

describe('login transaction cookie', () => {
  const tx = { state: 's', nonce: 'n', codeVerifier: 'v', returnTo: '/app/settings', exp: Date.now() + 60_000 };
  it('round-trips and rejects tampering, the wrong key and expiry', () => {
    const sealed = sealTransaction(tx, 'k'.repeat(32));
    expect(openTransaction(sealed, 'k'.repeat(32))).toEqual(tx);
    expect(openTransaction(sealed.replace(/^./, 'A'), 'k'.repeat(32))).toBeNull();
    expect(openTransaction(sealed, 'x'.repeat(32))).toBeNull();
    expect(openTransaction(sealed, 'k'.repeat(32), tx.exp + 1)).toBeNull();
  });
  it('limits return paths to /app/ and /admin', () => {
    expect(safeReturnTo('/app/devices')).toBe('/app/devices');
    expect(safeReturnTo('/admin/stations')).toBe('/admin/stations');
    expect(safeReturnTo('/admin')).toBe('/admin');
    for (const bad of ['https://x', '//x/app/', '/administrator', '/adminx/y', '/app/\\x', null]) expect(safeReturnTo(bad)).toBe('/app/settings');
  });
});

describe('MemorySessionStore', () => {
  it('expires on idle and absolute lifetime', async () => {
    let now = 0;
    const store = new MemorySessionStore(100, 250, () => now);
    const { id } = await store.create({ accessToken: 'a', expiresAt: 1 });
    now = 90;
    expect(await store.touch(id)).not.toBeNull();
    now = 180;
    expect(await store.touch(id)).not.toBeNull();
    now = 260;
    expect(await store.touch(id)).toBeNull();
    const { id: idle } = await store.create({ accessToken: 'a', expiresAt: 1 });
    now += 101;
    expect(await store.touch(idle)).toBeNull();
  });
});

describe('stream health helpers', () => {
  const region = { region: 'asia-southeast', checkedAt: '2026-10-03T00:00:00Z', latencyMs: 180, httpStatus: 200, reason: 'ok' };
  it('says why a stream is failing and how many times in a row', () => {
    expect(healthLine({ state: 'unknown', regions: [] })).toBe('ยังไม่ได้ตรวจ');
    expect(healthLine({ state: 'ok', regions: [{ ...region, state: 'ok', consecutiveFailures: 0 }] })).toBe('เล่นได้ · 180 ms');
    expect(
      healthLine({ state: 'suspect', regions: [{ ...region, state: 'suspect', reason: 'http_status', httpStatus: 503, consecutiveFailures: 3 }] }),
    ).toBe('น่าสงสัย · เซิร์ฟเวอร์ตอบข้อผิดพลาด (503) · 3 ครั้งติด');
  });

  it('counts only stations the apps can see', () => {
    const s = (publishedRevision: number | null, disabledAt: string | null, state: 'ok' | 'suspect') =>
      ({ publishedRevision, disabledAt, health: { state, regions: [] } }) as unknown as AdminStation;
    expect(countByHealth([s(1, null, 'ok'), s(1, null, 'suspect'), s(null, null, 'ok'), s(1, '2026-10-01', 'suspect')])).toEqual({
      unknown: 0,
      ok: 1,
      failing: 0,
      suspect: 1,
    });
  });
});

describe('station rights in lists', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const s = (rights: Partial<AdminStation['rights']>, published = true) =>
    ({ published: published ? {} : null, disabledAt: null, rights: { state: 'current', expiresAt: null, reference: null, liveUntil: null, ...rights } }) as unknown as AdminStation;

  it('reads the rights records summary, not draft fields', () => {
    expect(rightsLine(s({}))).toBe('สิทธิ์ไม่มีวันหมดอายุ');
    expect(rightsLine(s({ expiresAt: '2027-04-30' }))).toMatch(/^สิทธิ์ถึง /);
    expect(rightsLine(s({ state: 'missing' }))).toBe('ยังไม่มีข้อมูลสิทธิ์');
    expect(rightsLine(s({ state: 'territory' }))).toBe('สิทธิ์ไม่ครอบคลุมประเทศนี้');
    expect(rightsSoon(s({ expiresAt: '2026-10-20' }), now)).toBe(true);
    expect(rightsSoon(s({ expiresAt: '2027-10-20' }), now)).toBe(false);
    expect(rightsSoon(s({ state: 'missing' }), now)).toBe(true);
    expect(rightsDaysLeft(s({ expiresAt: '2026-10-14' }), now)).toBe(11);
    expect(rightsDaysLeft(s({ state: 'not_yet_valid', expiresAt: '2027-01-01' }), now)).toBeNull();
  });

  it('counts a published station as visible only while its public rights window is open', () => {
    expect(visibleInApps(s({}), now)).toBe(true);
    expect(visibleInApps(s({ liveUntil: '2026-12-31T23:59:59.999Z' }), now)).toBe(true);
    expect(visibleInApps(s({ liveUntil: '2026-10-04T11:00:00.000Z' }), now)).toBe(false);
    expect(visibleInApps(s({}, false), now)).toBe(false);
  });
});

describe('page language', () => {
  it('is Thai unless the switch chose English', () => {
    expect(langFrom('en')).toBe('en');
    expect(langFrom('th')).toBe('th');
    expect(langFrom(undefined)).toBe('th');
    expect(langFrom('xx')).toBe('th');
  });

  it("follows the browser for the account setting 'system', Thai unless English ranks above Thai", () => {
    expect(langFromAcceptLanguage('en-US,en;q=0.9')).toBe('en');
    expect(langFromAcceptLanguage('th-TH,th;q=0.9,en;q=0.8')).toBe('th');
    expect(langFromAcceptLanguage('fr-FR,en;q=0.5,th;q=0.4')).toBe('en');
    expect(langFromAcceptLanguage('en;q=0.3,th;q=0.7')).toBe('th');
    expect(langFromAcceptLanguage('en;q=0,fr')).toBe('th');
    expect(langFromAcceptLanguage('')).toBe('th');
    expect(langFromAcceptLanguage(null)).toBe('th');
    expect(accountLang('system', 'en')).toBe('en');
    expect(accountLang('system', 'th')).toBe('th');
    expect(accountLang('en', 'th')).toBe('en');
    expect(accountLang('th', 'en')).toBe('th');
    expect(accountLang(undefined, 'en')).toBe('th');
  });
});

describe('readBodyCapped', () => {
  it('reads a body under the cap and refuses one over it, declared or streamed', async () => {
    const { readBodyCapped } = await import('../src/lib/bff');
    expect(await readBodyCapped(new Request('http://x/', { method: 'POST', body: 'hello' }), 16)).toBe('hello');
    expect(await readBodyCapped(new Request('http://x/', { method: 'POST', body: 'x'.repeat(17) }), 16)).toBeNull();
    const streamed = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(8));
        c.close();
      },
    });
    const req = new Request('http://x/', { method: 'POST', body: streamed, duplex: 'half' } as RequestInit);
    expect(await readBodyCapped(req, 16)).toBeNull();
    expect(await readBodyCapped(new Request('http://x/', { method: 'GET' }), 16)).toBe('');
  });
});

describe('country and language names', () => {
  it('names codes in the page language and never repeats the country for Thai', async () => {
    const { countryName, languageName } = await import('../src/lib/names');
    expect(countryName('TH', 'th')).toBe('ไทย');
    expect(languageName('th', 'th')).toBe('ภาษาไทย');
    expect(countryName('th', 'en')).toBe('Thailand');
    expect(languageName('TH', 'en')).toBe('Thai');
    expect(languageName('en', 'th')).toBe('ภาษาอังกฤษ');
  });

  it('falls back to the code when there is no name', async () => {
    const { countryName, languageName } = await import('../src/lib/names');
    expect(countryName('XX', 'en')).toBe('XX');
    expect(languageName('zzz', 'th')).toBe('zzz');
  });
});
