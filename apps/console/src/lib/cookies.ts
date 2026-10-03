import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CookieOptions {
  secure: boolean;
  maxAgeSeconds?: number;
}

export function cookieNames(secure: boolean) {
  // __Host- forces Secure, Path=/ and no Domain, so subdomains cannot set or read it.
  const prefix = secure ? '__Host-' : '';
  return { session: `${prefix}td_session`, tx: `${prefix}td_login` };
}

export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (o.secure) parts.push('Secure');
  if (o.maxAgeSeconds !== undefined) parts.push(`Max-Age=${o.maxAgeSeconds}`);
  return parts.join('; ');
}

export const clearCookie = (name: string, secure: boolean) => serializeCookie(name, '', { secure, maxAgeSeconds: 0 });

export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Login transaction (state, nonce, PKCE verifier) kept in a signed, short-lived cookie. */
export interface LoginTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  exp: number;
}

export function sealTransaction(tx: LoginTransaction, secret: string): string {
  const body = Buffer.from(JSON.stringify(tx)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function openTransaction(value: string | undefined, secret: string, now = Date.now()): LoginTransaction | null {
  if (!value) return null;
  const [body, mac] = value.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(mac, expected)) return null;
  try {
    const tx = JSON.parse(Buffer.from(body, 'base64url').toString()) as LoginTransaction;
    return typeof tx.exp === 'number' && tx.exp > now ? tx : null;
  } catch {
    return null;
  }
}

/** Only same-site paths under /app/ may be used as a post-login destination. */
export function safeReturnTo(value: string | null | undefined): string {
  const fallback = '/app/settings';
  if (!value || !value.startsWith('/app/') || value.startsWith('//') || /[\\\s]/.test(value)) return fallback;
  return value.length <= 200 ? value : fallback;
}
