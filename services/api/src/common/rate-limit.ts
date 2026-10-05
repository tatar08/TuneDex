import { createHash } from 'node:crypto';
import { CallHandler, ExecutionContext, HttpStatus, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { APP_CONFIG, AppConfig } from '../config';
import { Database } from '../db/database';
import { ApiError } from './api-error';
import { StructuredLogger } from './logger';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PRUNE_EVERY_MS = 5 * 60_000;
const WARN_EVERY_MS = 60_000;

interface Rule {
  bucket: string;
  limit: number;
}

/** Client addresses are personal data: counters key on a short hash, never the address itself. */
const addressKey = (ip: string | undefined) => createHash('sha256').update(ip ?? 'unknown').digest('base64url').slice(0, 22);

/**
 * Doc 17 initial limits, counted per minute in PostgreSQL so every API instance shares them:
 * signed-in callers get `readsPerMinute` reads and `writesPerMinute` writes; the public
 * catalog gets `catalogPerMinutePerIp` per client address. Over the limit is 429
 * API_RATE_LIMITED with Retry-After. Runs after the guards, so it knows who the caller is.
 *
 * If the counter store fails the request is let through (and a warning logged): the limit
 * protects capacity, and failing every request because counting broke would be worse.
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  private lastPrune = 0;
  private lastWarn = 0;

  constructor(
    private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: StructuredLogger,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<Request>();
    const rule = this.config.rateLimit.enabled ? this.ruleFor(req) : null;
    if (rule) {
      const result = await this.hit(rule.bucket);
      if (result && result.hits > rule.limit) {
        context.switchToHttp().getResponse<Response>().setHeader('Retry-After', String(result.retryAfter));
        throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'API_RATE_LIMITED', { retryAfterSeconds: result.retryAfter });
      }
    }
    return next.handle();
  }

  private ruleFor(req: Request): Rule | null {
    const limits = this.config.rateLimit;
    if (req.actor) {
      return READ_METHODS.has(req.method)
        ? { bucket: `user:${req.actor.userId}:read`, limit: limits.readsPerMinute }
        : { bucket: `user:${req.actor.userId}:write`, limit: limits.writesPerMinute };
    }
    if (req.path.startsWith('/v1/catalog/')) return { bucket: `ip:${addressKey(req.ip)}:catalog`, limit: limits.catalogPerMinutePerIp };
    if (req.path.startsWith('/v1/directory/')) return { bucket: `ip:${addressKey(req.ip)}:directory`, limit: limits.catalogPerMinutePerIp };
    // Deletion progress is public (the account can no longer sign in); tickets are unguessable, but cap guessing anyway.
    if (req.path.startsWith('/v1/account-deletions/')) return { bucket: `ip:${addressKey(req.ip)}:deletion`, limit: limits.catalogPerMinutePerIp };
    // Store webhooks come from Apple's and Google's servers; checking a signature costs more than this counter,
    // so a flood from one address is cut off early. Generous, since one store address sends every notification.
    if (req.path.startsWith('/v1/webhooks/')) return { bucket: `ip:${addressKey(req.ip)}:webhook`, limit: limits.catalogPerMinutePerIp * 10 };
    // Export download links work without a sign-in too.
    if (req.path.startsWith('/v1/export-downloads/')) return { bucket: `ip:${addressKey(req.ip)}:export`, limit: limits.catalogPerMinutePerIp };
    return null;
  }

  private async hit(bucket: string): Promise<{ hits: number; retryAfter: number } | null> {
    try {
      const [row] = await this.db.query<{ hits: number; retry_after: number }>(
        `INSERT INTO rate_limit_counters (bucket, window_start, hits) VALUES ($1, date_trunc('minute', now()), 1)
         ON CONFLICT (bucket, window_start) DO UPDATE SET hits = rate_limit_counters.hits + 1
         RETURNING hits, GREATEST(1, CEIL(60 - EXTRACT(EPOCH FROM now() - window_start)))::int AS retry_after`,
        [bucket],
      );
      this.prune();
      return { hits: row.hits, retryAfter: row.retry_after };
    } catch (err) {
      if (Date.now() - this.lastWarn > WARN_EVERY_MS) {
        this.lastWarn = Date.now();
        this.logger.log('WARN', { eventCode: 'RATE_LIMIT_UNAVAILABLE', errorName: (err as Error)?.name ?? 'Error' });
      }
      return null;
    }
  }

  /** Drops finished windows now and then, off the request path. */
  private prune(): void {
    if (Date.now() - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = Date.now();
    void this.db.query(`DELETE FROM rate_limit_counters WHERE window_start < now() - interval '2 minutes'`).catch(() => undefined);
  }
}
