import { NextRequest, NextResponse } from 'next/server';

/**
 * A fresh nonce per request and a CSP that runs only scripts carrying it (Doc 13 XSS). Next.js reads the nonce
 * from the request's CSP header and puts it on its own scripts, so every page renders dynamically (root layout).
 * Styles stay 'unsafe-inline': React style attributes cannot carry a nonce, and styles cannot run code.
 * No form-action: logout posts to /auth/logout, which redirects to the IdP, and form-action also covers redirects.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const dev = process.env.NODE_ENV === 'development';
  // Home themes also play HTTPS catalog streams. Keep this permission limited
  // to the three playback entry pages; other routes retain the restrictive policy.
  const path = request.nextUrl.pathname;
  const player = ['/app/home', '/app/radio', '/app/explore'].includes(path);
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    player ? "connect-src 'self' https:" : "connect-src 'self'",
    player ? "media-src 'self' https: blob:" : "media-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join('; ');
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  // Once the console is served over https, browsers must not fall back to http (Doc 13). Read at runtime: the
  // same build serves http locally and https on staging.
  if (process.env.CONSOLE_BASE_URL?.startsWith('https://')) response.headers.set('Strict-Transport-Security', 'max-age=31536000');
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
