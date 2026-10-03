import { Injectable, Inject } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config';

export type Severity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * Fields allowed in a log line (Doc 17 log schema). Callers pass only these, so
 * headers, bodies, query strings, emails and tokens never reach the log.
 */
export interface LogFields {
  eventCode: string;
  requestId?: string;
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

@Injectable()
export class StructuredLogger {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOG_WRITER) private readonly write: LogWriter,
  ) {}

  log(severity: Severity, fields: LogFields): void {
    const line = {
      timestamp: new Date().toISOString(),
      severity,
      service: 'api',
      environment: this.config.env,
      build: this.config.build,
      ...fields,
    };
    this.write(JSON.stringify(line) + '\n');
  }
}
