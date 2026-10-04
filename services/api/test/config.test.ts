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
    expect(loadConfig(base).stationCheck).toEqual({ enabled: false, intervalMinutes: 15, region: 'default' });
  });

  it.each([
    ['STATION_CHECK_ENABLED', 'yes'],
    ['STATION_CHECK_INTERVAL_MIN', '1'],
    ['STATION_CHECK_INTERVAL_MIN', '7.5'],
    ['STATION_CHECK_REGION', 'Asia Southeast'],
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
});
