import 'server-only';
import { createBff, Bff } from './bff';
import { loadConfig } from './config';
import { OidcClient } from './oidc';
import { PgSessionStore } from './pg-session';
import { MemorySessionStore } from './session';

const holder = globalThis as unknown as { __tunedeckBff?: Bff };

/** Process-wide BFF built from the environment (kept on globalThis so dev reloads share sessions). */
export function getBff(): Bff {
  if (!holder.__tunedeckBff) {
    const config = loadConfig();
    holder.__tunedeckBff = createBff({
      config,
      oidc: new OidcClient(config),
      store: config.sessionDatabaseUrl
        ? PgSessionStore.connect(config.sessionDatabaseUrl, config.sessionSecret, config.sessionIdleMs, config.sessionAbsoluteMs)
        : new MemorySessionStore(config.sessionIdleMs, config.sessionAbsoluteMs),
    });
  }
  return holder.__tunedeckBff;
}
