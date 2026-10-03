import { describe, expect, it } from 'vitest';
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
  it('limits return paths to /app/', () => {
    expect(safeReturnTo('/app/devices')).toBe('/app/devices');
    for (const bad of ['https://x', '//x/app/', '/admin', '/app/\\x', null]) expect(safeReturnTo(bad)).toBe('/app/settings');
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
