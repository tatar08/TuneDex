import { DynamicModule, INestApplication, Module } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { JWTVerifyGetKey } from 'jose';
import type { Pool } from 'pg';
import { AuthGuard, KEY_RESOLVER } from './auth/auth.guard';
import { ErrorEnvelopeFilter } from './common/error.filter';
import { LOG_WRITER, LogWriter, StructuredLogger, stdoutWriter } from './common/logger';
import { requestContext } from './common/request-context';
import { APP_CONFIG, AppConfig } from './config';
import { Database, PG_POOL } from './db/database';
import { HealthController } from './health/health.controller';
import { SettingsController } from './settings/settings.controller';
import { SettingsService } from './settings/settings.service';
import { UsersService } from './users/users.service';

export interface AppDeps {
  config: AppConfig;
  pool: Pool;
  keyResolver: JWTVerifyGetKey;
  logWriter?: LogWriter;
}

@Module({})
export class AppModule {
  static forRoot(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, SettingsController],
      providers: [
        { provide: APP_CONFIG, useValue: deps.config },
        { provide: PG_POOL, useValue: deps.pool },
        { provide: KEY_RESOLVER, useValue: deps.keyResolver },
        { provide: LOG_WRITER, useValue: deps.logWriter ?? stdoutWriter },
        StructuredLogger,
        Database,
        UsersService,
        SettingsService,
        AuthGuard,
      ],
    };
  }
}

/** Shared HTTP setup for the real server and the test harness. */
export function configureApp(app: NestExpressApplication): INestApplication {
  const logger = app.get(StructuredLogger);
  app.disable('x-powered-by');
  app.use(requestContext(logger));
  app.useBodyParser('json', { limit: '16kb' });
  app.useGlobalFilters(new ErrorEnvelopeFilter(logger));
  return app;
}
