import { DynamicModule, INestApplication, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { Pool } from 'pg';
import { AccountDeletionStatusController, AccountService, MyAccountController } from './account/account';
import { AccountExportsService, ExportDownloadController, MyExportsController } from './account/exports';
import { IDP_FETCH, IdpFetch, IdpUsersService } from './account/idp-users';
import { AdminConfigController, AppConfigService, CONFIG_SIGNER, createConfigSigner, PublicConfigController } from './app-config/app-config';
import { AdminJobsController, JobsService } from './jobs/jobs';
import { AdminUsersController, AdminUsersService } from './users/admin-users';
import { AdminOverviewController, OverviewService } from './overview/overview';
import { AdminMetricsController, MetricsService } from './overview/metrics';
import { ALERT_FETCH, AlertFetch, AlertService } from './overview/alerts';
import { boundedFetch } from './common/bounded-fetch';
import { AdminDirectoryController, AdminDirectoryStationsController, DIRECTORY_FETCH, DirectoryController, DirectoryFetch, DirectoryService, UPSTREAM_MAX_BYTES } from './directory/directory';
import { AdminBrandLogoController, AdminStationLogoController, LOGO_FETCH, LOGO_MAX_BYTES, LogoController, LogoService } from './directory/logos';
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
import { DevicePreferencesController, DevicePreferencesService } from './devices/device-preferences';
import { AdminSupportDiagnosticsController, MySupportAccessController, SupportAccessService } from './diagnostics/support-access';
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
  /** Tests only: fake Radio Browser server. */
  directoryFetch?: DirectoryFetch;
  /** Tests only: fake DNS and HTTPS for station favicons. */
  logoFetch?: ProbeDeps;
  googlePushKeys?: JWTVerifyGetKey;
}

@Module({})
export class AppModule {
  static forRoot(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, SettingsController, DevicesController, DevicePreferencesController, AdminStationsController, CatalogController, StaffController, AdminLogsController, AdminAuditController, DiagnosticsUploadController, MyDiagnosticsController, MyAccountController, AccountDeletionStatusController, MyExportsController, ExportDownloadController, AdminOverviewController, AdminMetricsController, AdminJobsController, AdminUsersController, AdminSupportDiagnosticsController, MySupportAccessController, AdminConfigController, PublicConfigController, SyncController, FavoritesController, BillingController, DirectoryController, AdminDirectoryController, AdminDirectoryStationsController, LogoController, AdminStationLogoController, AdminBrandLogoController],
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
        DevicePreferencesService,
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
        AccountExportsService,
        OverviewService,
        MetricsService,
        AlertService,
        DirectoryService,
        LogoService,
        ...(deps.logoFetch ? [{ provide: LOGO_FETCH, useValue: deps.logoFetch }] : []),
        { provide: DIRECTORY_FETCH, useValue: deps.directoryFetch ?? ((url: string, init: Parameters<DirectoryFetch>[1]) => boundedFetch(url, init, UPSTREAM_MAX_BYTES)) },
        { provide: ALERT_FETCH, useValue: deps.alertFetch ?? ((url: string, init: Parameters<AlertFetch>[1]) => boundedFetch(url, init, 64 * 1024)) },
        JobsService,
        AdminUsersService,
        SupportAccessService,
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
  // Paths are matched exactly, so /V1/Directory/... cannot reach a route while slipping past the rate limits and
  // idempotency rules, which compare the path as written. Nest has already made Express's router by now, so the
  // setting alone would not reach it; routes are added later (at init) and read the router's own flag.
  app.set('case sensitive routing', true);
  (app.getHttpAdapter().getInstance().router as unknown as { caseSensitive: boolean }).caseSensitive = true;
  // Only our own proxies' X-Forwarded-For is believed; 0 means the socket address.
  const config = app.get<AppConfig>(APP_CONFIG);
  app.set('trust proxy', config.rateLimit.trustProxyHops);
  // Doc 17: an explicit per-environment allowlist; with none set, no CORS headers at all. No cookies cross origins.
  if (config.corsAllowedOrigins.length > 0) {
    app.enableCors({
      origin: config.corsAllowedOrigins,
      credentials: false,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'If-Match', 'If-None-Match', 'Idempotency-Key', 'X-Request-Id', 'traceparent'],
      exposedHeaders: ['ETag', 'Retry-After', 'X-Request-Id', 'Idempotent-Replayed', 'Location', 'traceparent'],
      maxAge: 600,
    });
  }
  app.use(requestContext(logger));
  // Diagnostic batches may be up to 128 KiB (Doc 17); every other body stays at 16 KiB. Registered first, so it wins for that path.
  app.use('/v1/diagnostics/batches', json({ limit: DIAGNOSTIC_LIMITS.batchBytes }));
  // A full sync push (100 changes) is about 25 KiB.
  app.use('/v1/sync/push', json({ limit: PUSH_MAX_BYTES }));
  // Store payloads carry certificate chains.
  app.use(['/v1/billing/verify', '/v1/webhooks'], json({ limit: WEBHOOK_MAX_BYTES }));
  // A logo upload is a small image in base64 (at most 64 KiB, so about 88 KiB of JSON).
  app.use([/^\/v1\/admin\/directory\/stations\/[^/]+\/logo$/, '/v1/admin/brand/station-logo'], json({ limit: Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 1024 }));
  app.useBodyParser('json', { limit: '16kb' });
  app.useGlobalFilters(new ErrorEnvelopeFilter(logger));
  return app;
}
