import { DynamicModule, INestApplication, Module } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { JWTVerifyGetKey } from 'jose';
import type { Pool } from 'pg';
import { AdminAuditController, AuditSearchService } from './audit/audit-search';
import { AuthGuard, KEY_RESOLVER } from './auth/auth.guard';
import { ErrorEnvelopeFilter } from './common/error.filter';
import { LOG_SINK, LOG_WRITER, LogWriter, StructuredLogger, stdoutWriter } from './common/logger';
import { requestContext } from './common/request-context';
import { APP_CONFIG, AppConfig } from './config';
import { Database, PG_POOL } from './db/database';
import { DevicesController } from './devices/devices.controller';
import { DevicesService } from './devices/devices.service';
import { HealthController } from './health/health.controller';
import { PgLogStore } from './logs/log-store';
import { AdminLogsController, LogsService } from './logs/logs';
import { SettingsController } from './settings/settings.controller';
import { SettingsService } from './settings/settings.service';
import { StaffController, StaffGuard, StaffService } from './staff/staff';
import { AdminStationsController, CatalogController } from './stations/stations.controller';
import { PROBE_DEPS, StationHealthService } from './stations/station-health';
import { StationsService } from './stations/stations.service';
import type { ProbeDeps } from './stations/stream-probe';
import { UsersService } from './users/users.service';

export interface AppDeps {
  config: AppConfig;
  pool: Pool;
  keyResolver: JWTVerifyGetKey;
  logWriter?: LogWriter;
  /** Tests only: fake DNS/HTTPS for the stream checker. Production uses the real ones. */
  probeDeps?: ProbeDeps;
}

@Module({})
export class AppModule {
  static forRoot(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, SettingsController, DevicesController, AdminStationsController, CatalogController, StaffController, AdminLogsController, AdminAuditController],
      providers: [
        { provide: APP_CONFIG, useValue: deps.config },
        { provide: PG_POOL, useValue: deps.pool },
        { provide: KEY_RESOLVER, useValue: deps.keyResolver },
        { provide: LOG_WRITER, useValue: deps.logWriter ?? stdoutWriter },
        PgLogStore,
        { provide: LOG_SINK, useExisting: PgLogStore },
        StructuredLogger,
        LogsService,
        AuditSearchService,
        Database,
        UsersService,
        SettingsService,
        DevicesService,
        StaffService,
        StationsService,
        StationHealthService,
        ...(deps.probeDeps ? [{ provide: PROBE_DEPS, useValue: deps.probeDeps }] : []),
        AuthGuard,
        StaffGuard,
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
