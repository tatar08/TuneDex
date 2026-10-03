import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createRemoteJWKSet } from 'jose';
import { AppModule, configureApp } from './app.module';
import { loadConfig } from './config';
import { createPool } from './db/database';

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
  app.enableShutdownHooks();
  await app.listen(config.port);
}

void bootstrap();
