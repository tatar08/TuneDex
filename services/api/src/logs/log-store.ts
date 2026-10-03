import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { LOG_WRITER, LogLine, LogSink, LogWriter } from '../common/logger';
import { PG_POOL } from '../db/database';

export const LOG_RETENTION_DAYS = 14;
const MAX_BUFFER = 2000;
const BATCH = 200;
const FLUSH_MS = 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const COLUMNS = 14;

/** Health probes run every few seconds; they stay on stdout but are not worth keeping for search. */
const kept = (l: LogLine) => !(l.eventCode === 'HTTP_REQUEST' && l.route?.startsWith('/health'));

/**
 * Buffers log lines and writes them to `operational_logs` in batches, off the request path.
 * If the database is down the batch is dropped and counted (stdout still has every line):
 * logging must never slow down or fail a request.
 */
@Injectable()
export class PgLogStore implements LogSink, OnApplicationShutdown {
  private buffer: LogLine[] = [];
  private dropped = 0;
  private flushing: Promise<void> | null = null;
  private lastPrune = 0;
  private readonly timer: NodeJS.Timeout;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(LOG_WRITER) private readonly write: LogWriter,
  ) {
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  add(line: LogLine): void {
    if (!kept(line)) return;
    if (this.buffer.length >= MAX_BUFFER) {
      this.buffer.shift();
      this.dropped++;
    }
    this.buffer.push(line);
  }

  /** Writes everything buffered so far. Safe to call concurrently. */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing;
    if (!this.buffer.length && Date.now() - this.lastPrune < PRUNE_EVERY_MS) return;
    this.flushing = this.drain().finally(() => (this.flushing = null));
    await this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.buffer.length) {
      const batch = this.buffer.splice(0, BATCH);
      try {
        await this.insert(batch);
      } catch {
        this.dropped += batch.length;
        break;
      }
    }
    if (this.dropped) {
      // Straight to stdout, not back into the buffer, so a database outage cannot feed itself.
      this.write(JSON.stringify({ timestamp: new Date().toISOString(), severity: 'WARN', service: 'api', eventCode: 'LOG_STORE_DROPPED', count: this.dropped }) + '\n');
      this.dropped = 0;
    }
    if (Date.now() - this.lastPrune >= PRUNE_EVERY_MS) {
      this.lastPrune = Date.now();
      await this.prune().catch(() => undefined);
    }
  }

  private async insert(batch: LogLine[]): Promise<void> {
    const params: unknown[] = [];
    const rows = batch.map((l, i) => {
      params.push(l.timestamp, l.severity, l.service, l.environment, l.build, l.eventCode, l.requestId ?? null, l.method ?? null, l.route ?? null, l.status ?? null, l.durationMs ?? null, l.actorId ?? null, l.errorName ?? null, l.errorCode ?? null);
      return `(${Array.from({ length: COLUMNS }, (_, j) => `$${i * COLUMNS + j + 1}`).join(', ')})`;
    });
    await this.pool.query(
      `INSERT INTO operational_logs (logged_at, severity, service, environment, build, event_code, request_id, method, route, status, duration_ms, actor_id, error_name, error_code)
       VALUES ${rows.join(', ')}`,
      params,
    );
  }

  /** Deletes lines past retention in small chunks so a large backlog never holds a long lock. */
  private async prune(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const r = await this.pool.query(
        `DELETE FROM operational_logs WHERE id IN (
           SELECT id FROM operational_logs WHERE logged_at < now() - make_interval(days => $1) LIMIT 5000)`,
        [LOG_RETENTION_DAYS],
      );
      if ((r.rowCount ?? 0) < 5000) return;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.flush().catch(() => undefined);
  }
}
