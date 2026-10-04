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
  /** Scheduled stream checks of published stations (Doc 17). Off unless STATION_CHECK_ENABLED=true. */
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
    stationCheck: loadStationCheck(env),
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
