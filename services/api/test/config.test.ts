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

  it('keeps stream checks off by default', () => {
    expect(loadConfig(base).stationCheck).toEqual({ enabled: false, intervalMinutes: 15, region: 'default' });
  });

  it.each([
    ['STATION_CHECK_ENABLED', 'yes'],
    ['STATION_CHECK_INTERVAL_MIN', '1'],
    ['STATION_CHECK_INTERVAL_MIN', '7.5'],
    ['STATION_CHECK_REGION', 'Asia Southeast'],
  ])('refuses %s=%s', (key, value) => {
    expect(() => loadConfig({ ...base, [key]: value })).toThrow(key);
  });
});
