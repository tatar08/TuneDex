import 'reflect-metadata';
import { DynamicModule, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Pool } from 'pg';
import { LOG_SINK, LOG_WRITER, LogWriter, stdoutWriter, StructuredLogger } from './common/logger';
import { APP_CONFIG, AppConfig, loadConfig } from './config';
import { createPool, Database, PG_POOL } from './db/database';
import { PgLogStore } from './logs/log-store';
import { PROBE_DEPS, StationHealthService } from './stations/station-health';
import type { ProbeDeps } from './stations/stream-probe';

/**
 * Doc 17 stream checker as its own process (`npm run checker`): no HTTP server, only the scheduled passes
 * and staff "check now" requests. Run it where outbound HTTPS is allowed and set STATION_CHECK_RUNNER=worker
 * on the API, which then needs no outbound access to stream hosts.
 */
@Module({})
export class CheckerModule {
  static forRoot(deps: { config: AppConfig; pool: Pool; logWriter?: LogWriter; probeDeps?: ProbeDeps }): DynamicModule {
    return {
      module: CheckerModule,
      providers: [
        { provide: APP_CONFIG, useValue: deps.config },
        { provide: PG_POOL, useValue: deps.pool },
        { provide: LOG_WRITER, useValue: deps.logWriter ?? stdoutWriter },
        PgLogStore,
        { provide: LOG_SINK, useExisting: PgLogStore },
        StructuredLogger,
        Database,
        StationHealthService,
        ...(deps.probeDeps ? [{ provide: PROBE_DEPS, useValue: deps.probeDeps }] : []),
      ],
    };
  }
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const app = await NestFactory.createApplicationContext(CheckerModule.forRoot({ config, pool }), { logger: ['error', 'warn'] });
  app.enableShutdownHooks();
  app.get(StationHealthService).startWorker();
}

if (require.main === module) void bootstrap();
