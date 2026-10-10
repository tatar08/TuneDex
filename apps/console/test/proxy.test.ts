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

describe('proxy media policy', () => {
  it('allows https media and fetches on /app/radio only', () => {
    const radio = proxy(new NextRequest('https://console.example.test/app/radio')).headers.get('content-security-policy')!;
    expect(radio).toContain("media-src 'self' https: blob:");
    expect(radio).toContain("connect-src 'self' https:");
    expect(radio).not.toContain('http:');
    const other = proxy(new NextRequest('https://console.example.test/app/settings')).headers.get('content-security-policy')!;
    expect(other).toContain("connect-src 'self';");
    expect(other).toContain("media-src 'self'");
    expect(other).not.toContain('https:');
  });
});

describe('proxy explore policy', () => {
  it('allows https media and station logos on /app/explore, and https pictures nowhere else', () => {
    const explore = proxy(new NextRequest('https://console.example.test/app/explore')).headers.get('content-security-policy')!;
    expect(explore).toContain("img-src 'self' data: blob: https:;");
    expect(explore).toContain("media-src 'self' https: blob:");
    for (const path of ['/app/radio', '/admin/directory', '/admin/settings', '/app/explore/x']) {
      expect(proxy(new NextRequest(`https://console.example.test${path}`)).headers.get('content-security-policy')).toContain("img-src 'self' data: blob:;");
    }
  });
});
