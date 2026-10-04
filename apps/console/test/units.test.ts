import { describe, expect, it } from 'vitest';
import { countByHealth, healthLine } from '@/lib/admin';
import type { AdminStation } from '@/lib/bff';
import { loadConfig } from '@/lib/config';
import { openTransaction, safeReturnTo, sealTransaction } from '@/lib/cookies';
import { MemorySessionStore } from '@/lib/session';

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
  it('needs a shared session database outside localhost', () => {
    expect(() => loadConfig({ ...env, SESSION_DATABASE_URL: '' })).toThrow('SESSION_DATABASE_URL');
    expect(() => loadConfig({ ...env, SESSION_DATABASE_URL: 'redis://x' })).toThrow('SESSION_DATABASE_URL');
    expect(loadConfig({ ...env, SESSION_DATABASE_URL: '', CONSOLE_BASE_URL: 'http://localhost:3200' }).sessionDatabaseUrl).toBeNull();
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
