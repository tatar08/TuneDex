import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { proxy } from '@/proxy';

afterEach(() => vi.unstubAllEnvs());

describe('proxy security headers', () => {
  it('adds HSTS only when the console is served over https', () => {
    vi.stubEnv('CONSOLE_BASE_URL', 'https://console.example.test');
    const secure = proxy(new NextRequest('https://console.example.test/login'));
    expect(secure.headers.get('strict-transport-security')).toBe('max-age=31536000');
    expect(secure.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

    vi.stubEnv('CONSOLE_BASE_URL', 'http://localhost:3200');
    expect(proxy(new NextRequest('http://localhost:3200/login')).headers.get('strict-transport-security')).toBeNull();
  });
});
