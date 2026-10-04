export type AppEnv = 'dev' | 'staging' | 'production';

export interface AppConfig {
  env: AppEnv;
  build: string;
  port: number;
  databaseUrl: string;
  oidc: {
    issuer: string;
    audience: string;
    jwksUri: string;
    algorithms: string[];
  };
  /** Per-minute request limits (Doc 17 initial limits). Off only in tests. */
  rateLimit: {
    enabled: boolean;
    readsPerMinute: number;
    writesPerMinute: number;
    catalogPerMinutePerIp: number;
    /** Express `trust proxy` hop count, so client addresses come from X-Forwarded-For set by our own proxy. */
    trustProxyHops: number;
  };
  /**
   * Keycloak admin access used to delete the sign-in identity when an account is deleted. Required in staging
   * and production; in dev it may be left out and deletion then keeps the Keycloak user.
   */
  idpAdmin: { tokenUrl: string; adminBase: string; clientId: string; clientSecret: string } | null;
  /**
   * Ed25519 private key (PKCS#8 PEM) that signs GET /v1/config. Required in staging and production, where the
   * apps pin its public key; dev without one signs with a throwaway key per start.
   */
  configSigningKey: string | null;
  /**
   * Store purchase verification (Doc 11, ADR-12). Each store is off until its keys are set; with a store off,
   * verification and its notifications answer 503 and nothing is granted.
   */
  billing: {
    apple: { bundleId: string; rootCaPem: string; productIds: string[]; environments: Array<'Production' | 'Sandbox'> } | null;
    google: {
      packageName: string;
      productIds: string[];
      serviceAccount: { clientEmail: string; privateKeyPem: string };
      /** Pub/Sub push: the audience and the service account Google signs push requests as. */
      pushAudience: string;
      pushServiceAccount: string;
    } | null;
  };
  /**
   * Daily removal of audit records older than 180 days (Doc 17 retention, confirmed by Tar 2026-10-04).
   * On unless AUDIT_RETENTION_ENABLED=false.
   */
  auditRetentionEnabled: boolean;
  /**
   * Doc 17: privileged operations (publish, rollback, audit export) need MFA within the last 5 minutes. The
   * token's `acr` must be one of these values (Keycloak step-up level of assurance). Required outside dev;
   * dev without it does not ask for MFA.
   */
  staffMfaAcr: string[] | null;
  /** Scheduled stream checks of published stations (Doc 17). Off unless STATION_CHECK_ENABLED=true. */
  /** Doc 17 alerts: evaluated every minute; transitions go to the logs and, when set, to a webhook. */
  alerts: { enabled: boolean; webhookUrl: string | null };
  stationCheck: {
    enabled: boolean;
    intervalMinutes: number;
    region: string;
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

const ENVS: AppEnv[] = ['dev', 'staging', 'production'];

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value.trim();
}

/** Reads configuration from the environment and fails fast; there is no auth bypass switch. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const appEnv = required(env, 'APP_ENV') as AppEnv;
  if (!ENVS.includes(appEnv)) {
    throw new Error(`APP_ENV must be one of ${ENVS.join(', ')}`);
  }
  const port = Number(env.PORT ?? 3100);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('PORT must be a positive integer');
  }
  const algorithms = (env.OIDC_ALGORITHMS ?? 'RS256')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  if (algorithms.length === 0 || algorithms.some((a) => a === 'none' || a.startsWith('HS'))) {
    throw new Error('OIDC_ALGORITHMS must list asymmetric algorithms only');
  }
  return {
    env: appEnv,
    build: env.BUILD_VERSION ?? 'unknown',
    port,
    databaseUrl: required(env, 'DATABASE_URL'),
    oidc: {
      issuer: required(env, 'OIDC_ISSUER'),
      audience: required(env, 'OIDC_AUDIENCE'),
      jwksUri: required(env, 'OIDC_JWKS_URI'),
      algorithms,
    },
    rateLimit: loadRateLimit(env),
    idpAdmin: loadIdpAdmin(env, appEnv, required(env, 'OIDC_ISSUER')),
    configSigningKey: loadConfigSigningKey(env, appEnv),
    billing: { apple: loadApple(env), google: loadGoogle(env) },
    auditRetentionEnabled: flag(env, 'AUDIT_RETENTION_ENABLED', true),
    staffMfaAcr: loadStaffMfa(env, appEnv),
    alerts: loadAlerts(env),
    stationCheck: loadStationCheck(env),
  };
}

/** The realm comes from the issuer (`…/realms/<realm>`), so the admin calls always target the realm that signs our tokens. */
function loadIdpAdmin(env: NodeJS.ProcessEnv, appEnv: AppEnv, issuer: string): AppConfig['idpAdmin'] {
  const clientId = env.KEYCLOAK_ADMIN_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.KEYCLOAK_ADMIN_CLIENT_SECRET?.trim() ?? '';
  if (!clientId && !clientSecret) {
    if (appEnv !== 'dev') throw new Error('Missing required environment variable KEYCLOAK_ADMIN_CLIENT_ID (account deletion removes the Keycloak user)');
    return null;
  }
  if (!clientId) throw new Error('Missing required environment variable KEYCLOAK_ADMIN_CLIENT_ID');
  if (!clientSecret) throw new Error('Missing required environment variable KEYCLOAK_ADMIN_CLIENT_SECRET');
  const m = /^(https?:\/\/[^/]+(?:\/[^/]+)*?)\/realms\/([^/]+)\/?$/.exec(issuer);
  if (!m) throw new Error('OIDC_ISSUER must be a Keycloak realm URL (…/realms/<realm>) to delete Keycloak users');
  const [, base, realm] = m;
  return {
    tokenUrl: `${base}/realms/${realm}/protocol/openid-connect/token`,
    adminBase: `${base}/admin/realms/${realm}`,
    clientId,
    clientSecret,
  };
}

/** Accepts the PEM as is, or on one line with `\n` escapes as most secret stores hold it. */
function loadConfigSigningKey(env: NodeJS.ProcessEnv, appEnv: AppEnv): string | null {
  const raw = env.CONFIG_SIGNING_KEY?.trim() ?? '';
  if (!raw) {
    if (appEnv !== 'dev') throw new Error('Missing required environment variable CONFIG_SIGNING_KEY (the apps verify remote config with its public key)');
    return null;
  }
  const pem = raw.replace(/\\n/g, '\n');
  if (!/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----$/.test(pem)) throw new Error('CONFIG_SIGNING_KEY must be a PKCS#8 PEM private key');
  return pem;
}

const pemOf = (raw: string) => raw.replace(/\\n/g, '\n');
const listOf = (raw: string | undefined) => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const PRODUCT_ID = /^[A-Za-z0-9._]{1,100}$/;

/** Apple: off unless APPLE_BUNDLE_ID is set; then the root certificate and product ids are required. */
function loadApple(env: NodeJS.ProcessEnv): AppConfig['billing']['apple'] {
  const bundleId = env.APPLE_BUNDLE_ID?.trim() ?? '';
  if (!bundleId) return null;
  const rootCaPem = pemOf(required(env, 'APPLE_ROOT_CA_PEM'));
  if (!/^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----$/.test(rootCaPem)) throw new Error('APPLE_ROOT_CA_PEM must be a PEM certificate (Apple Root CA - G3)');
  const productIds = listOf(env.APPLE_PRO_PRODUCT_IDS);
  if (productIds.length === 0 || productIds.some((p) => !PRODUCT_ID.test(p))) throw new Error('APPLE_PRO_PRODUCT_IDS must list the Pro product ids');
  const environments = listOf(env.APPLE_ENVIRONMENTS ?? 'Production');
  if (environments.length === 0 || environments.some((e) => e !== 'Production' && e !== 'Sandbox')) throw new Error('APPLE_ENVIRONMENTS must be Production and/or Sandbox');
  return { bundleId, rootCaPem, productIds, environments: environments as Array<'Production' | 'Sandbox'> };
}

/** Google: off unless GOOGLE_PLAY_PACKAGE_NAME is set; then the service account and Pub/Sub push settings are required. */
function loadGoogle(env: NodeJS.ProcessEnv): AppConfig['billing']['google'] {
  const packageName = env.GOOGLE_PLAY_PACKAGE_NAME?.trim() ?? '';
  if (!packageName) return null;
  const productIds = listOf(env.GOOGLE_PLAY_PRO_PRODUCT_IDS);
  if (productIds.length === 0 || productIds.some((p) => !PRODUCT_ID.test(p))) throw new Error('GOOGLE_PLAY_PRO_PRODUCT_IDS must list the Pro product ids');
  let account: { client_email?: unknown; private_key?: unknown };
  try {
    account = JSON.parse(required(env, 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'));
  } catch {
    throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON must be the service account key JSON');
  }
  if (typeof account.client_email !== 'string' || typeof account.private_key !== 'string') throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON must hold client_email and private_key');
  return {
    packageName,
    productIds,
    serviceAccount: { clientEmail: account.client_email, privateKeyPem: pemOf(account.private_key) },
    pushAudience: required(env, 'GOOGLE_PUBSUB_PUSH_AUDIENCE'),
    pushServiceAccount: required(env, 'GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT'),
  };
}

/** The webhook URL is a secret (chat webhooks carry their token in the path): it is never logged. */
function loadAlerts(env: NodeJS.ProcessEnv): AppConfig['alerts'] {
  const raw = env.ALERT_WEBHOOK_URL?.trim() ?? '';
  if (raw) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error('ALERT_WEBHOOK_URL must be an https URL');
    }
    if (u.protocol !== 'https:' || u.username || u.password) throw new Error('ALERT_WEBHOOK_URL must be an https URL');
  }
  return { enabled: flag(env, 'ALERTS_ENABLED', true), webhookUrl: raw || null };
}

function loadStaffMfa(env: NodeJS.ProcessEnv, appEnv: AppEnv): string[] | null {
  const values = listOf(env.STAFF_MFA_ACR);
  if (values.length === 0) {
    if (appEnv !== 'dev') throw new Error('Missing required environment variable STAFF_MFA_ACR (the acr values that mean MFA, e.g. 2)');
    return null;
  }
  if (values.some((v) => !/^[A-Za-z0-9:._-]{1,64}$/.test(v))) throw new Error('STAFF_MFA_ACR must list acr values');
  return values;
}

function flag(env: NodeJS.ProcessEnv, key: string, fallback = false): boolean {
  const v = (env[key] ?? String(fallback)).trim();
  if (v !== 'true' && v !== 'false') throw new Error(`${key} must be true or false`);
  return v === 'true';
}

function wholeNumber(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const n = Number(env[key] ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be a whole number from ${min} to ${max}`);
  return n;
}

function loadRateLimit(env: NodeJS.ProcessEnv): AppConfig['rateLimit'] {
  return {
    enabled: true,
    readsPerMinute: wholeNumber(env, 'RATE_LIMIT_READS_PER_MIN', 120, 1, 100_000),
    writesPerMinute: wholeNumber(env, 'RATE_LIMIT_WRITES_PER_MIN', 30, 1, 100_000),
    catalogPerMinutePerIp: wholeNumber(env, 'RATE_LIMIT_CATALOG_PER_MIN', 60, 1, 100_000),
    trustProxyHops: wholeNumber(env, 'TRUST_PROXY_HOPS', 0, 0, 5),
  };
}

function loadStationCheck(env: NodeJS.ProcessEnv): AppConfig['stationCheck'] {
  const enabled = (env.STATION_CHECK_ENABLED ?? 'false').trim();
  if (enabled !== 'true' && enabled !== 'false') throw new Error('STATION_CHECK_ENABLED must be true or false');
  const intervalMinutes = Number(env.STATION_CHECK_INTERVAL_MIN ?? 15);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) {
    throw new Error('STATION_CHECK_INTERVAL_MIN must be a whole number of minutes from 5 to 1440');
  }
  const region = (env.STATION_CHECK_REGION ?? 'default').trim();
  if (!/^[a-z0-9-]{1,32}$/.test(region)) throw new Error('STATION_CHECK_REGION must be 1-32 lowercase letters, digits or dashes');
  return { enabled: enabled === 'true', intervalMinutes, region };
}
