import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createRemoteJWKSet } from 'jose';
import { AppModule, configureApp } from './app.module';
import { loadConfig } from './config';
import { createPool } from './db/database';
import { HealthController } from './health/health.controller';

/** How long readiness reports 503 before the server stops accepting connections (SHUTDOWN_DRAIN_MS, default 5 s). */
function drainMs(): number {
  const n = Number(process.env.SHUTDOWN_DRAIN_MS);
  return Number.isInteger(n) && n >= 0 && n <= 60_000 ? n : 5000;
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const keyResolver = createRemoteJWKSet(new URL(config.oidc.jwksUri), {
    timeoutDuration: 5000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({ config, pool, keyResolver }),
    { logger: ['error', 'warn'], bodyParser: false },
  );
  configureApp(app);
  await app.listen(config.port);

  // Graceful stop: fail readiness, let in-flight requests and the load balancer catch up, close the server and
  // the workers (Nest shutdown hooks), then the database pool. A second signal exits at once.
  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    app.get(HealthController).drain();
    await new Promise((r) => setTimeout(r, drainMs()));
    let code = 0;
    try {
      await app.close();
      await pool.end();
    } catch {
      code = 1;
    }
    process.exit(code);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => void stop());
}

void bootstrap();
