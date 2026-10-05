import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, Inject, Optional } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config';

export type Severity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * Fields allowed in a log line (Doc 17 log schema). Callers pass only these, so
 * headers, bodies, query strings, emails and tokens never reach the log.
 */
export interface LogFields {
  eventCode: string;
  requestId?: string;
  /** W3C trace id (32 lowercase hex) of the request the line belongs to. */
  traceId?: string;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  actorId?: string;
  errorName?: string;
  errorCode?: string;
}

/** Where serialized log lines go: stdout at runtime, an in-memory buffer in tests. */
export const LOG_WRITER = Symbol('LOG_WRITER');
export type LogWriter = (line: string) => void;
export const stdoutWriter: LogWriter = (line) => {
  process.stdout.write(line);
};

export interface LogLine extends LogFields {
  timestamp: string;
  severity: Severity;
  service: string;
  environment: string;
  build: string;
}

/** A second destination that keeps lines for staff search. Must never throw or block the caller. */
export const LOG_SINK = Symbol('LOG_SINK');
export interface LogSink {
  add(line: LogLine): void;
}

/**
 * The trace of the request being served, set by requestContext. Lines logged while serving it
 * (rate limiter, idempotency store, error filter) carry its trace id without passing it around.
 */
export const traceScope = new AsyncLocalStorage<{ traceId: string }>();

@Injectable()
export class StructuredLogger {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOG_WRITER) private readonly write: LogWriter,
    @Optional() @Inject(LOG_SINK) private readonly sink?: LogSink,
  ) {}

  log(severity: Severity, fields: LogFields): void {
    const traceId = fields.traceId ?? traceScope.getStore()?.traceId;
    const line: LogLine = {
      timestamp: new Date().toISOString(),
      severity,
      service: 'api',
      environment: this.config.env,
      build: this.config.build,
      ...fields,
      ...(traceId && { traceId }),
    };
    this.write(JSON.stringify(line) + '\n');
    this.sink?.add(line);
  }
}
