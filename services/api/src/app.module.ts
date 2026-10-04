import { DynamicModule, INestApplication, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { Pool } from 'pg';
import { AccountDeletionStatusController, AccountService, MyAccountController } from './account/account';
import { IDP_FETCH, IdpFetch, IdpUsersService } from './account/idp-users';
import { AdminConfigController, AppConfigService, CONFIG_SIGNER, createConfigSigner, PublicConfigController } from './app-config/app-config';
import { AdminJobsController, JobsService } from './jobs/jobs';
import { AdminUsersController, AdminUsersService } from './users/admin-users';
import { AdminOverviewController, OverviewService } from './overview/overview';
import { ALERT_FETCH, AlertFetch, AlertService } from './overview/alerts';
import { AdminAuditController, AuditSearchService } from './audit/audit-search';
import { AuthGuard, KEY_RESOLVER } from './auth/auth.guard';
import { ErrorEnvelopeFilter } from './common/error.filter';
import { IdempotencyInterceptor } from './common/idempotency';
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
import { FavoritesController, PUSH_MAX_BYTES, SyncController, SyncService } from './sync/sync';
import { AuditRetentionService } from './audit/audit-retention';
import { BillingController, BillingService, GOOGLE_FETCH, GOOGLE_PUSH_KEYS, WEBHOOK_MAX_BYTES } from './billing/billing';
import type { GoogleFetch } from './billing/google';
import type { ProbeDeps } from './stations/stream-probe';
import { UsersService } from './users/users.service';

export interface AppDeps {
  config: AppConfig;
  pool: Pool;
  keyResolver: JWTVerifyGetKey;
  logWriter?: LogWriter;
  /** Tests only: fake DNS/HTTPS for the stream checker. Production uses the real ones. */
  probeDeps?: ProbeDeps;
  /** Tests only: fake Keycloak admin API. Production uses the global fetch. */
  idpFetch?: IdpFetch;
  /** Tests only: fake Google Play API and Pub/Sub token keys. */
  googleFetch?: GoogleFetch;
  /** Tests only: replaces the network for the alert webhook. */
  alertFetch?: AlertFetch;
  googlePushKeys?: JWTVerifyGetKey;
}

@Module({})
export class AppModule {
  static forRoot(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, SettingsController, DevicesController, AdminStationsController, CatalogController, StaffController, AdminLogsController, AdminAuditController, DiagnosticsUploadController, MyDiagnosticsController, MyAccountController, AccountDeletionStatusController, AdminOverviewController, AdminJobsController, AdminUsersController, AdminConfigController, PublicConfigController, SyncController, FavoritesController, BillingController],
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
        IdpUsersService,
        AppConfigService,
        SyncService,
        AuditRetentionService,
        BillingService,
        { provide: GOOGLE_FETCH, useValue: deps.googleFetch ?? ((input: string, init?: Parameters<GoogleFetch>[1]) => fetch(input, init)) },
        { provide: GOOGLE_PUSH_KEYS, useValue: deps.googlePushKeys ?? createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')) },
        { provide: CONFIG_SIGNER, useValue: createConfigSigner(deps.config.configSigningKey) },
        { provide: IDP_FETCH, useValue: deps.idpFetch ?? ((input: Parameters<IdpFetch>[0], init?: Parameters<IdpFetch>[1]) => fetch(input, init)) },
        OverviewService,
        AlertService,
        { provide: ALERT_FETCH, useValue: deps.alertFetch ?? ((url: string, init: Parameters<AlertFetch>[1]) => fetch(url, init)) },
        JobsService,
        AdminUsersService,
        StaffService,
        StationsService,
        StationHealthService,
        ...(deps.probeDeps ? [{ provide: PROBE_DEPS, useValue: deps.probeDeps }] : []),
        AuthGuard,
        StaffGuard,
        { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
        // After the rate limit, so a replay still counts as a write.
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
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
  // A full sync push (100 changes) is about 25 KiB.
  app.use('/v1/sync/push', json({ limit: PUSH_MAX_BYTES }));
  // Store payloads carry certificate chains.
  app.use(['/v1/billing/verify', '/v1/webhooks'], json({ limit: WEBHOOK_MAX_BYTES }));
  app.useBodyParser('json', { limit: '16kb' });
  app.useGlobalFilters(new ErrorEnvelopeFilter(logger));
  return app;
}
