import { loadConfig } from '../src/config';

const base = {
  APP_ENV: 'dev',
  DATABASE_URL: 'postgres://x@localhost/db',
  OIDC_ISSUER: 'https://idp/realms/t',
  OIDC_AUDIENCE: 'tunedeck-api',
  OIDC_JWKS_URI: 'https://idp/realms/t/certs',
};

describe('loadConfig', () => {
  it('loads a complete environment', () => {
    expect(loadConfig(base).oidc.algorithms).toEqual(['RS256']);
  });

  it.each(['APP_ENV', 'DATABASE_URL', 'OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS_URI'])('fails fast without %s', (key) => {
    const env = { ...base } as Record<string, string>;
    delete env[key];
    expect(() => loadConfig(env)).toThrow(key);
  });

  it.each(['none', 'HS256', 'RS256,HS512'])('refuses symmetric or empty algorithms (%s)', (alg) => {
    expect(() => loadConfig({ ...base, OIDC_ALGORITHMS: alg })).toThrow();
  });

  it('refuses an unknown environment name', () => {
    expect(() => loadConfig({ ...base, APP_ENV: 'prod' })).toThrow('APP_ENV');
  });

  it('uses the Doc 17 request limits by default and trusts no proxy', () => {
    expect(loadConfig(base).rateLimit).toEqual({ enabled: true, readsPerMinute: 120, writesPerMinute: 30, catalogPerMinutePerIp: 60, trustProxyHops: 0 });
  });

  it('keeps stream checks off by default', () => {
    expect(loadConfig(base).stationCheck).toEqual({ enabled: false, intervalMinutes: 15, region: 'default', runner: 'api' });
  });

  it.each([
    ['STATION_CHECK_ENABLED', 'yes'],
    ['STATION_CHECK_INTERVAL_MIN', '1'],
    ['STATION_CHECK_INTERVAL_MIN', '7.5'],
    ['STATION_CHECK_REGION', 'Asia Southeast'],
    ['STATION_CHECK_RUNNER', 'both'],
    ['RATE_LIMIT_READS_PER_MIN', '0'],
    ['RATE_LIMIT_WRITES_PER_MIN', 'many'],
    ['RATE_LIMIT_CATALOG_PER_MIN', '1.5'],
    ['TRUST_PROXY_HOPS', '9'],
  ])('refuses %s=%s', (key, value) => {
    expect(() => loadConfig({ ...base, [key]: value })).toThrow(key);
  });

  it('reads the Keycloak admin client and derives its URLs from the issuer realm', () => {
    expect(loadConfig(base).idpAdmin).toBeNull();
    const cfg = loadConfig({ ...base, KEYCLOAK_ADMIN_CLIENT_ID: 'api-admin', KEYCLOAK_ADMIN_CLIENT_SECRET: 's3cret', OIDC_ISSUER: 'https://id.example/auth/realms/tunedeck' });
    expect(cfg.idpAdmin).toEqual({
      tokenUrl: 'https://id.example/auth/realms/tunedeck/protocol/openid-connect/token',
      adminBase: 'https://id.example/auth/admin/realms/tunedeck',
      clientId: 'api-admin',
      clientSecret: 's3cret',
    });
  });

  it('requires the Keycloak admin client outside dev, and both halves of it anywhere', () => {
    expect(() => loadConfig({ ...base, APP_ENV: 'production' })).toThrow('KEYCLOAK_ADMIN_CLIENT_ID');
    expect(() => loadConfig({ ...base, KEYCLOAK_ADMIN_CLIENT_ID: 'api-admin' })).toThrow('KEYCLOAK_ADMIN_CLIENT_SECRET');
    expect(() => loadConfig({ ...base, KEYCLOAK_ADMIN_CLIENT_ID: 'a', KEYCLOAK_ADMIN_CLIENT_SECRET: 'b', OIDC_ISSUER: 'https://id.example/oauth' })).toThrow('OIDC_ISSUER');
  });

  it('reads the config signing key, also from a one-line secret, and requires it outside dev', () => {
    const { generateKeyPairSync } = require('node:crypto') as typeof import('node:crypto');
    const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim();
    expect(loadConfig(base).configSigningKey).toBeNull();
    expect(loadConfig({ ...base, CONFIG_SIGNING_KEY: pem.replace(/\n/g, '\\n') }).configSigningKey).toBe(pem);
    expect(() => loadConfig({ ...base, CONFIG_SIGNING_KEY: 'not a key' })).toThrow('CONFIG_SIGNING_KEY');
    const idp = { KEYCLOAK_ADMIN_CLIENT_ID: 'a', KEYCLOAK_ADMIN_CLIENT_SECRET: 'b' };
    expect(() => loadConfig({ ...base, ...idp, APP_ENV: 'staging' })).toThrow('CONFIG_SIGNING_KEY');
    expect(loadConfig({ ...base, ...idp, APP_ENV: 'staging', CONFIG_SIGNING_KEY: pem, STAFF_MFA_ACR: '2' }).configSigningKey).toBe(pem);
  });

  it('keeps billing off per store until it is configured, then requires everything that store needs', () => {
    expect(loadConfig(base).billing).toEqual({ apple: null, google: null });
    const cert = '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----';
    expect(() => loadConfig({ ...base, APPLE_BUNDLE_ID: 'app.tunedeck' })).toThrow('APPLE_ROOT_CA_PEM');
    expect(() => loadConfig({ ...base, APPLE_BUNDLE_ID: 'app.tunedeck', APPLE_ROOT_CA_PEM: cert })).toThrow('APPLE_PRO_PRODUCT_IDS');
    const apple = loadConfig({ ...base, APPLE_BUNDLE_ID: 'app.tunedeck', APPLE_ROOT_CA_PEM: cert, APPLE_PRO_PRODUCT_IDS: 'tunedeck.pro' }).billing.apple;
    expect(apple).toMatchObject({ productIds: ['tunedeck.pro'], environments: ['Production'] });
    expect(() => loadConfig({ ...base, GOOGLE_PLAY_PACKAGE_NAME: 'app.tunedeck', GOOGLE_PLAY_PRO_PRODUCT_IDS: 'pro' })).toThrow('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
    expect(() => loadConfig({ ...base, GOOGLE_PLAY_PACKAGE_NAME: 'app.tunedeck', GOOGLE_PLAY_PRO_PRODUCT_IDS: 'pro', GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: '{}' })).toThrow('client_email');
    const google = loadConfig({
      ...base,
      GOOGLE_PLAY_PACKAGE_NAME: 'app.tunedeck',
      GOOGLE_PLAY_PRO_PRODUCT_IDS: 'pro',
      GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'a@b', private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----' }),
      GOOGLE_PUBSUB_PUSH_AUDIENCE: 'https://api/v1/webhooks/google',
      GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT: 'rtdn@p.iam.gserviceaccount.com',
    }).billing.google;
    expect(google).toMatchObject({ packageName: 'app.tunedeck', serviceAccount: { clientEmail: 'a@b' } });
  });

  it('allows CORS only for listed exact origins', () => {
    expect(loadConfig(base).corsAllowedOrigins).toEqual([]);
    expect(loadConfig({ ...base, CORS_ALLOWED_ORIGINS: 'https://a.example, http://localhost:3000' }).corsAllowedOrigins).toEqual(['https://a.example', 'http://localhost:3000']);
    for (const bad of ['*', 'https://a.example/path', 'a.example']) {
      expect(() => loadConfig({ ...base, CORS_ALLOWED_ORIGINS: bad })).toThrow('CORS_ALLOWED_ORIGINS');
    }
  });

  it('requires the MFA acr values outside dev, and removes old audit records unless told not to', () => {
    expect(loadConfig(base).staffMfaAcr).toBeNull();
    expect(loadConfig({ ...base, STAFF_MFA_ACR: '2, gold' }).staffMfaAcr).toEqual(['2', 'gold']);
    const pem = '-----BEGIN PRIVATE KEY-----\\nx\\n-----END PRIVATE KEY-----';
    const staging = { ...base, APP_ENV: 'staging', KEYCLOAK_ADMIN_CLIENT_ID: 'a', KEYCLOAK_ADMIN_CLIENT_SECRET: 'b', CONFIG_SIGNING_KEY: pem };
    expect(() => loadConfig(staging)).toThrow('STAFF_MFA_ACR');
    expect(loadConfig(base).auditRetentionEnabled).toBe(true);
    expect(loadConfig({ ...base, AUDIT_RETENTION_ENABLED: 'false' }).auditRetentionEnabled).toBe(false);
  });
  it('evaluates alerts by default and accepts only an https webhook', () => {
    expect(loadConfig(base).alerts).toEqual({ enabled: true, webhookUrl: null });
    expect(loadConfig({ ...base, ALERTS_ENABLED: 'false' }).alerts.enabled).toBe(false);
    expect(loadConfig({ ...base, ALERT_WEBHOOK_URL: 'https://hooks.example.test/abc' }).alerts.webhookUrl).toBe('https://hooks.example.test/abc');
    for (const bad of ['http://hooks.example.test/abc', 'https://user:pw@hooks.example.test/', 'not a url']) {
      expect(() => loadConfig({ ...base, ALERT_WEBHOOK_URL: bad })).toThrow('ALERT_WEBHOOK_URL');
    }
  });
});
