import { describe, expect, it } from 'vitest';
import { countByHealth, healthLine, logApiParams, logHref, logSearchFrom } from '@/lib/admin';
import type { AdminStation } from '@/lib/bff';
import { loadConfig } from '@/lib/config';
import { openTransaction, safeReturnTo, sealTransaction } from '@/lib/cookies';
import { createLogger, traceIdFrom } from '@/lib/log';
import { MemorySessionStore } from '@/lib/session';
import { langFrom } from '@/lib/lang';

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

describe('page language', () => {
  it('is Thai unless the switch chose English', () => {
    expect(langFrom('en')).toBe('en');
    expect(langFrom('th')).toBe('th');
    expect(langFrom(undefined)).toBe('th');
    expect(langFrom('xx')).toBe('th');
  });
});
