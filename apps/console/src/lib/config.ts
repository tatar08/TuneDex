export interface ConsoleConfig {
  baseUrl: string;
  apiBaseUrl: string;
  oidc: { issuer: string; clientId: string; clientSecret: string; scopes: string; algorithms: string[] };
  sessionSecret: string;
  /** Secure cookies (and the __Host- prefix) everywhere except plain-http localhost development. */
  secureCookies: boolean;
  /** Doc 17: web user session idle 12 hours. Absolute lifetime is a proposal. */
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
}

function required(env: Record<string, string | undefined>, key: string): string {
  const v = env[key]?.trim();
  if (!v) throw new Error(`Missing required environment variable ${key}`);
  return v;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ConsoleConfig {
  const baseUrl = new URL(required(env, 'CONSOLE_BASE_URL'));
  const isLocalHttp = baseUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(baseUrl.hostname);
  if (baseUrl.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('CONSOLE_BASE_URL must use https outside localhost');
  }
  const sessionSecret = required(env, 'SESSION_SECRET');
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  const algorithms = (env.OIDC_ALGORITHMS ?? 'RS256').split(',').map((a) => a.trim()).filter(Boolean);
  if (algorithms.length === 0 || algorithms.some((a) => a === 'none' || a.startsWith('HS'))) {
    throw new Error('OIDC_ALGORITHMS must list asymmetric algorithms only');
  }
  return {
    baseUrl: baseUrl.origin,
    apiBaseUrl: new URL(required(env, 'API_BASE_URL')).origin,
    oidc: {
      issuer: required(env, 'OIDC_ISSUER'),
      clientId: required(env, 'OIDC_CLIENT_ID'),
      clientSecret: required(env, 'OIDC_CLIENT_SECRET'),
      scopes: env.OIDC_SCOPES?.trim() || 'openid',
      algorithms,
    },
    sessionSecret,
    secureCookies: !isLocalHttp,
    sessionIdleMs: 12 * 60 * 60 * 1000,
    sessionAbsoluteMs: 7 * 24 * 60 * 60 * 1000,
  };
}
