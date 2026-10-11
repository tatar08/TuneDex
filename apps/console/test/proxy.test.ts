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
  it('allows HTTPS streams on playback entry pages, with other pages restricted', () => {
    for (const path of ['/app/home', '/app/radio', '/app/explore']) {
    const radio = proxy(new NextRequest(`https://console.example.test${path}`)).headers.get('content-security-policy')!;
    expect(radio).toContain("media-src 'self' https: blob:");
    expect(radio).toContain("connect-src 'self' https:");
    expect(radio).not.toContain('http:');
    }
    for (const path of ['/app/settings', '/admin/settings', '/login', '/application', '/app/home-other']) {
    const other = proxy(new NextRequest(`https://console.example.test${path}`)).headers.get('content-security-policy')!;
    expect(other).toContain("connect-src 'self';");
    expect(other).toContain("media-src 'self'");
    expect(other).not.toContain('https:');
    }
  });
});

describe('proxy explore policy', () => {
  it('allows https media on /app/explore and loads no map tiles from anywhere', () => {
    const explore = proxy(new NextRequest('https://console.example.test/app/explore')).headers.get('content-security-policy')!;
    expect(explore).toContain("img-src 'self' data: blob:;");
    expect(explore).toContain("media-src 'self' https: blob:");
  });
});
