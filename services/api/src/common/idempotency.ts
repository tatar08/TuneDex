import { createHash } from 'node:crypto';
import { CallHandler, ExecutionContext, HttpStatus, Injectable, NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import type { Request, Response } from 'express';
import { catchError, from, mergeMap, Observable, of, throwError } from 'rxjs';
import { Database } from '../db/database';
import { ApiError, DependencyUnavailableError } from './api-error';
import { StructuredLogger } from './logger';

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
/** Doc 17: at least 24 hours. */
export const IDEMPOTENCY_TTL_HOURS = 24;
/** A claim left behind by a crashed instance is taken over after this. */
const STALE_CLAIM_MINUTES = 5;
const PRUNE_EVERY_MS = 60 * 60_000;
/** Response headers that belong to the result and are replayed with it. */
const KEPT_HEADERS = ['etag', 'location'];

const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url');

interface Stored {
  request_hash: string;
  state: 'in_progress' | 'done';
  response_status: number | null;
  response_body: unknown;
  response_headers: Record<string, string>;
}

/**
 * Doc 17 mutation idempotency. A signed-in POST/PUT/PATCH/DELETE that carries an
 * `Idempotency-Key` header runs at most once per (account, method and path, key) for 24 hours:
 * - a repeat with the same body and If-Match gets the first response again, with `Idempotent-Replayed: true`;
 * - a repeat with a different body is 409 IDEMPOTENCY_KEY_REUSED;
 * - a repeat while the first is still running is 409 IDEMPOTENCY_IN_PROGRESS with Retry-After.
 * Only successful responses are kept. An error releases the key, so the client can retry with it.
 * Requests without the header behave as before. Runs after the guards (it needs the account)
 * and after the rate limit.
 *
 * Unlike the rate limit this does not fail open: if the store is down the request is 503,
 * because running a payment-like or destructive call twice is worse than asking for a retry.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private lastPrune = 0;

  constructor(
    private readonly db: Database,
    private readonly logger: StructuredLogger,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const header = req.header('idempotency-key');
    if (header === undefined || !req.actor || !MUTATIONS.has(req.method)) return next.handle();
    if (!KEY_PATTERN.test(header)) throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field: 'Idempotency-Key' });

    const userId = req.actor.userId;
    const scope = `${req.method} ${req.path}`;
    const keyHash = sha256(header);
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const requestHash = sha256(JSON.stringify([req.body ?? null, query, req.header('if-match') ?? null]));

    const claimed = await this.claim(userId, scope, keyHash, requestHash);
    if (!claimed) {
      const prior = await this.read(userId, scope, keyHash);
      // Gone between the two statements (the first run failed): ask for a retry rather than racing again.
      if (!prior || prior.state === 'in_progress') {
        if (prior && prior.request_hash !== requestHash) throw new ApiError(HttpStatus.CONFLICT, 'IDEMPOTENCY_KEY_REUSED');
        res.setHeader('Retry-After', '1');
        throw new ApiError(HttpStatus.CONFLICT, 'IDEMPOTENCY_IN_PROGRESS', { retryAfterSeconds: 1 });
      }
      if (prior.request_hash !== requestHash) throw new ApiError(HttpStatus.CONFLICT, 'IDEMPOTENCY_KEY_REUSED');
      for (const [name, value] of Object.entries(prior.response_headers)) res.setHeader(name, value);
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(prior.response_status ?? HttpStatus.OK);
      return of(prior.response_body ?? undefined);
    }

    const status: number = Reflect.getMetadata(HTTP_CODE_METADATA, context.getHandler()) ?? (req.method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK);
    const release = () => this.release(userId, scope, keyHash);
    return next.handle().pipe(
      mergeMap((body) => from(this.complete(userId, scope, keyHash, status, body, res).then(() => body))),
      catchError((err) => from(release()).pipe(mergeMap(() => throwError(() => err)))),
    );
  }

  /** Takes the key, or retakes it when its earlier use has expired or its claim was abandoned. True when this request owns it. */
  private async claim(userId: string, scope: string, keyHash: string, requestHash: string): Promise<boolean> {
    try {
      const rows = await this.db.query(
        `INSERT INTO idempotency_keys (user_id, scope, key_hash, request_hash, state) VALUES ($1, $2, $3, $4, 'in_progress')
         ON CONFLICT (user_id, scope, key_hash) DO UPDATE
           SET request_hash = EXCLUDED.request_hash, state = 'in_progress', response_status = NULL,
               response_body = NULL, response_headers = '{}'::jsonb, created_at = now()
           WHERE idempotency_keys.created_at < now() - make_interval(hours => $5)
              OR (idempotency_keys.state = 'in_progress' AND idempotency_keys.created_at < now() - make_interval(mins => $6))
         RETURNING 1`,
        [userId, scope, keyHash, requestHash, IDEMPOTENCY_TTL_HOURS, STALE_CLAIM_MINUTES],
      );
      this.prune();
      return rows.length === 1;
    } catch (err) {
      this.warn(err);
      throw new DependencyUnavailableError('database');
    }
  }

  private async read(userId: string, scope: string, keyHash: string): Promise<Stored | undefined> {
    try {
      const [row] = await this.db.query<Stored>(
        `SELECT request_hash, state, response_status, response_body, response_headers FROM idempotency_keys
         WHERE user_id = $1 AND scope = $2 AND key_hash = $3`,
        [userId, scope, keyHash],
      );
      return row;
    } catch (err) {
      this.warn(err);
      throw new DependencyUnavailableError('database');
    }
  }

  /** Keeps the result. A result that is not plain JSON (a file, a hand-written response) is not replayable, so the key is released instead. */
  private async complete(userId: string, scope: string, keyHash: string, status: number, body: unknown, res: Response): Promise<void> {
    const plain = !res.headersSent && (body === undefined || body === null || Object.getPrototypeOf(body) === Object.prototype || Array.isArray(body));
    if (!plain) return this.release(userId, scope, keyHash);
    const headers: Record<string, string> = {};
    for (const name of KEPT_HEADERS) {
      const value = res.getHeader(name);
      if (typeof value === 'string') headers[name] = value;
    }
    try {
      await this.db.query(
        `UPDATE idempotency_keys SET state = 'done', response_status = $4, response_body = $5::jsonb, response_headers = $6::jsonb
         WHERE user_id = $1 AND scope = $2 AND key_hash = $3`,
        [userId, scope, keyHash, status, body === undefined ? null : JSON.stringify(body), JSON.stringify(headers)],
      );
    } catch (err) {
      // The change itself succeeded: answer normally. A retry with this key then waits out the stale claim.
      this.warn(err);
    }
  }

  private async release(userId: string, scope: string, keyHash: string): Promise<void> {
    await this.db
      .query(`DELETE FROM idempotency_keys WHERE user_id = $1 AND scope = $2 AND key_hash = $3 AND state = 'in_progress'`, [userId, scope, keyHash])
      .catch((err) => this.warn(err));
  }

  private warn(err: unknown): void {
    this.logger.log('WARN', { eventCode: 'IDEMPOTENCY_STORE_FAILED', errorName: (err as Error)?.name ?? 'Error' });
  }

  /** Drops expired keys now and then, off the request path. */
  private prune(): void {
    if (Date.now() - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = Date.now();
    void this.db
      .query(`DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => $1)`, [IDEMPOTENCY_TTL_HOURS])
      .catch(() => undefined);
  }
}
