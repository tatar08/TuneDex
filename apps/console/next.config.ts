import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  // No form-action here: logout posts to /auth/logout, which redirects to the IdP's end-session URL, and form-action also applies to redirects.
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'" },
  // same-origin, not no-referrer: no-referrer makes browsers send `Origin: null` on form posts, which the CSRF check rejects.
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
