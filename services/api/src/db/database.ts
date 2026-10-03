import { Inject, Injectable } from '@nestjs/common';
import { Pool, QueryResultRow } from 'pg';
import { DependencyUnavailableError } from '../common/api-error';

export const PG_POOL = Symbol('PG_POOL');

/** Errors that mean "database unreachable/unavailable" rather than a bug in our SQL. */
function isAvailabilityError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (typeof e?.code === 'string') {
    if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH'].includes(e.code)) return true;
    // 08xxx connection exceptions, 57P0x admin shutdown / cannot connect now, 53300 too many connections, 57014 statement timeout
    if (/^08/.test(e.code) || /^57P0/.test(e.code) || e.code === '53300' || e.code === '57014') return true;
  }
  return /timeout|Connection terminated/i.test(e?.message ?? '');
}

@Injectable()
export class Database {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async query<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    try {
      const result = await this.pool.query<T>(sql, params);
      return result.rows;
    } catch (err) {
      if (isAvailabilityError(err)) throw new DependencyUnavailableError('postgres');
      throw err;
    }
  }

  /** Readiness check bounded by the pool's connection timeout. */
  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}

export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30000,
    statement_timeout: 5000,
  });
}
