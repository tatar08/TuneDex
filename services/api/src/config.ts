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
  };
}
