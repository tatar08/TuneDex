import { DynamicModule, INestApplication, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import type { JWTVerifyGetKey } from 'jose';
import type { Pool } from 'pg';
import { AccountDeletionStatusController, AccountService, MyAccountController } from './account/account';
import { AdminOverviewController, OverviewService } from './overview/overview';
import { AdminAuditController, AuditSearchService } from './audit/audit-search';
import { AuthGuard, KEY_RESOLVER } from './auth/auth.guard';
import { ErrorEnvelopeFilter } from './common/error.filter';
import { RateLimitInterceptor } from './common/rate-limit';
import { LOG_SINK, LOG_WRITER, LogWriter, StructuredLogger, stdoutWriter } from './common/logger';
import { requestContext } from './common/request-context';
import { APP_CONFIG, AppConfig } from './config';
import { Database, PG_POOL } from './db/database';
import { DevicesController } from './devices/devices.controller';
import { DiagnosticsService, DiagnosticsUploadController, LIMITS as DIAGNOSTIC_LIMITS, MyDiagnosticsController } from './diagnostics/diagnostics';
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
      controllers: [HealthController, SettingsController, DevicesController, AdminStationsController, CatalogController, StaffController, AdminLogsController, AdminAuditController, DiagnosticsUploadController, MyDiagnosticsController, MyAccountController, AccountDeletionStatusController, AdminOverviewController],
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
        DiagnosticsService,
        AccountService,
        OverviewService,
        StaffService,
        StationsService,
        StationHealthService,
        ...(deps.probeDeps ? [{ provide: PROBE_DEPS, useValue: deps.probeDeps }] : []),
        AuthGuard,
        StaffGuard,
        { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
      ],
    };
  }
}

/** Shared HTTP setup for the real server and the test harness. */
export function configureApp(app: NestExpressApplication): INestApplication {
  const logger = app.get(StructuredLogger);
  app.disable('x-powered-by');
  // Only our own proxies' X-Forwarded-For is believed; 0 means the socket address.
  app.set('trust proxy', app.get<AppConfig>(APP_CONFIG).rateLimit.trustProxyHops);
  app.use(requestContext(logger));
  // Diagnostic batches may be up to 128 KiB (Doc 17); every other body stays at 16 KiB. Registered first, so it wins for that path.
  app.use('/v1/diagnostics/batches', json({ limit: DIAGNOSTIC_LIMITS.batchBytes }));
  app.useBodyParser('json', { limit: '16kb' });
  app.useGlobalFilters(new ErrorEnvelopeFilter(logger));
  return app;
}
