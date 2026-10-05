import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown, Post, Req, Res, UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { JWTVerifyGetKey } from 'jose';
import { writeAudit } from '../audit/audit';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError, DependencyUnavailableError } from '../common/api-error';
import { StructuredLogger } from '../common/logger';
import { APP_CONFIG, AppConfig } from '../config';
import { Database } from '../db/database';
import { AppleNotification, AppleSignatureError, AppleTransaction, verifyAppleJws } from './apple';
import { DeveloperNotification, GoogleApiError, GoogleFetch, GooglePlayClient, ProductPurchase, verifyPubSubToken } from './google';

export const GOOGLE_FETCH = Symbol('GOOGLE_FETCH');
/** Google's public keys for Pub/Sub push tokens (remote JWKS at runtime, a local key set in tests). */
export const GOOGLE_PUSH_KEYS = Symbol('GOOGLE_PUSH_KEYS');
export const WEBHOOK_MAX_BYTES = 64 * 1024;
/** Handled notification ids are kept this long. Apple retries for about 3 days and Pub/Sub for at most 7, so a redelivery is still recognised. */
export const NOTIFICATION_RETENTION_DAYS = 30;
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;

export type Store = 'apple' | 'google';
export type PurchaseState = 'verified' | 'pending' | 'revoked';

export interface PurchaseView {
  store: Store;
  productId: string;
  state: PurchaseState;
  environment: 'production' | 'sandbox';
  purchasedAt: string | null;
  verifiedAt: string | null;
  revokedAt: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = (field: string, reason: string) => new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field, reason });
const refused = (reason: string) => new ApiError(HttpStatus.BAD_REQUEST, 'PURCHASE_INVALID', { reason });
/** Only this digest of the store's purchase identity is stored; the identifier itself never is. */
const digestOf = (store: Store, id: string) => createHash('sha256').update(`${store}:${id}`).digest('base64url');

export type VerifyRequest = { store: 'apple'; signedTransaction: string } | { store: 'google'; productId: string; purchaseToken: string };

export function parseVerify(body: unknown): VerifyRequest {
  if (!isObject(body)) throw invalid('body', 'must_be_object');
  if (body.store === 'apple') {
    for (const k of Object.keys(body)) if (k !== 'store' && k !== 'signedTransaction') throw invalid(k, 'unknown_field');
    const s = body.signedTransaction;
    if (typeof s !== 'string' || s.length > 32_768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s)) throw invalid('signedTransaction', 'must_be_jws');
    return { store: 'apple', signedTransaction: s };
  }
  if (body.store === 'google') {
    for (const k of Object.keys(body)) if (!['store', 'productId', 'purchaseToken'].includes(k)) throw invalid(k, 'unknown_field');
    if (typeof body.productId !== 'string' || !/^[A-Za-z0-9._]{1,100}$/.test(body.productId)) throw invalid('productId', 'invalid');
    if (typeof body.purchaseToken !== 'string' || !/^[A-Za-z0-9._:-]{10,4096}$/.test(body.purchaseToken)) throw invalid('purchaseToken', 'invalid');
    return { store: 'google', productId: body.productId, purchaseToken: body.purchaseToken };
  }
  throw invalid('store', 'unsupported');
}

interface Row {
  id: string;
  user_id: string;
  store: Store;
  product_id: string;
  environment: 'production' | 'sandbox';
  state: PurchaseState;
  purchased_at: Date | null;
  verified_at: Date | null;
  revoked_at: Date | null;
  owner_status?: string;
}

const view = (r: Row): PurchaseView => ({
  store: r.store,
  productId: r.product_id,
  state: r.state,
  environment: r.environment,
  purchasedAt: r.purchased_at?.toISOString() ?? null,
  verifiedAt: r.verified_at?.toISOString() ?? null,
  revokedAt: r.revoked_at?.toISOString() ?? null,
});

/**
 * Doc 11 / ADR-12: Pro is unlocked only by a purchase the server verified with the store. The app's word,
 * a client boolean or a bare transaction id never grant anything, a staff member cannot set it, and when a
 * store cannot be reached nothing new is granted (what was verified before stays).
 */
@Injectable()
export class BillingService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly google: GooglePlayClient | null;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Database,
    private readonly logger: StructuredLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(GOOGLE_FETCH) googleFetch: GoogleFetch,
    @Inject(GOOGLE_PUSH_KEYS) private readonly pushKeys: JWTVerifyGetKey,
  ) {
    this.google = config.billing.google ? new GooglePlayClient(config.billing.google, googleFetch) : null;
  }

  onApplicationBootstrap(): void {
    const run = () => void this.pruneNotifications().catch(() => this.logger.log('ERROR', { eventCode: 'STORE_NOTIFICATION_PRUNE_FAILED' }));
    this.timer = setInterval(run, PRUNE_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Forgets handled notification ids past retention, in small chunks. */
  async pruneNotifications(): Promise<number> {
    let removed = 0;
    for (let i = 0; i < 50; i++) {
      const rows = await this.db.query(
        `DELETE FROM store_notifications WHERE (store, digest) IN (
           SELECT store, digest FROM store_notifications WHERE received_at < now() - make_interval(days => $1) LIMIT 5000) RETURNING 1`,
        [NOTIFICATION_RETENTION_DAYS],
      );
      removed += rows.length;
      if (rows.length < 5000) break;
    }
    return removed;
  }

  /**
   * A webhook for a store that is not set up cannot authenticate its caller, so it answers like a failed
   * signature: an anonymous probe learns nothing about which stores are configured. Logged so a missing key shows.
   */
  private notConfigured(store: Store): ApiError {
    this.logger.log('WARN', { eventCode: 'STORE_WEBHOOK_NOT_CONFIGURED', errorCode: store.toUpperCase() });
    return new ApiError(HttpStatus.UNAUTHORIZED, 'AUTH_REQUIRED');
  }

  async entitlements(userId: string): Promise<{ pro: Record<Store, PurchaseState | 'none'>; purchases: PurchaseView[] }> {
    const rows = await this.db.query<Row>('SELECT * FROM purchases WHERE user_id = $1 ORDER BY created_at', [userId]);
    const pro: Record<Store, PurchaseState | 'none'> = { apple: 'none', google: 'none' };
    // Store-scoped in R1: a purchase on one store unlocks Pro on that store's app only.
    const rank = { none: 0, revoked: 1, pending: 2, verified: 3 } as const;
    for (const r of rows) if (rank[r.state] > rank[pro[r.store]]) pro[r.store] = r.state;
    return { pro, purchases: rows.map(view) };
  }

  async verify(userId: string, req: VerifyRequest, requestId?: string): Promise<PurchaseView> {
    return req.store === 'apple' ? this.verifyApple(userId, req.signedTransaction, requestId) : this.verifyGoogle(userId, req.productId, req.purchaseToken, requestId);
  }

  private async verifyApple(userId: string, jws: string, requestId?: string): Promise<PurchaseView> {
    const cfg = this.config.billing.apple;
    if (!cfg) throw new DependencyUnavailableError('apple');
    let tx: AppleTransaction;
    try {
      tx = await verifyAppleJws<AppleTransaction>(jws, cfg.rootCaPem);
    } catch (err) {
      if (err instanceof AppleSignatureError) throw refused('signature');
      throw err;
    }
    if (tx.bundleId !== cfg.bundleId) throw refused('wrong_app');
    if (!cfg.productIds.includes(tx.productId)) throw refused('unknown_product');
    if (!cfg.environments.includes(tx.environment as 'Production')) throw refused('environment');
    if (typeof tx.originalTransactionId !== 'string' || !tx.originalTransactionId) throw refused('malformed');
    // The app sets appAccountToken to the signed-in account's id at purchase; a different account cannot claim it.
    if (tx.appAccountToken !== undefined && (typeof tx.appAccountToken !== 'string' || !UUID.test(tx.appAccountToken) || tx.appAccountToken.toLowerCase() !== userId)) throw refused('account_mismatch');
    return this.record(userId, {
      store: 'apple',
      productId: tx.productId,
      digest: digestOf('apple', tx.originalTransactionId),
      environment: tx.environment === 'Sandbox' ? 'sandbox' : 'production',
      state: tx.revocationDate ? 'revoked' : 'verified',
      purchasedAt: typeof tx.purchaseDate === 'number' ? new Date(tx.purchaseDate) : null,
      requestId,
    });
  }

  private async verifyGoogle(userId: string, productId: string, token: string, requestId?: string): Promise<PurchaseView> {
    const cfg = this.config.billing.google;
    if (!cfg || !this.google) throw new DependencyUnavailableError('google');
    if (!cfg.productIds.includes(productId)) throw refused('unknown_product');
    const purchase = await this.googleCall(() => this.google!.getProduct(productId, token));
    if (!purchase) throw refused('unknown_purchase');
    if (purchase.purchaseState === 1) throw refused('cancelled');
    if (purchase.obfuscatedExternalAccountId !== undefined && purchase.obfuscatedExternalAccountId !== userId) throw refused('account_mismatch');
    const result = await this.record(userId, {
      store: 'google',
      productId,
      digest: digestOf('google', token),
      environment: purchase.purchaseType === 0 ? 'sandbox' : 'production',
      state: purchase.purchaseState === 0 ? 'verified' : 'pending',
      purchasedAt: purchase.purchaseTimeMillis ? new Date(Number(purchase.purchaseTimeMillis)) : null,
      requestId,
    });
    await this.acknowledgeIfNeeded(result, purchase, productId, token);
    return result;
  }

  /** Acknowledge only after the entitlement is stored. A failure is logged; the next verify or notification retries it. */
  private async acknowledgeIfNeeded(result: PurchaseView, purchase: ProductPurchase, productId: string, token: string): Promise<void> {
    if (result.state !== 'verified' || purchase.acknowledgementState === 1) return;
    await this.google!.acknowledge(productId, token).catch((err) => {
      this.logger.log('WARN', { eventCode: 'GOOGLE_ACK_FAILED', ...(err instanceof GoogleApiError ? { status: err.status } : { errorName: (err as Error)?.name }) });
    });
  }

  private async googleCall<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      this.logger.log('WARN', { eventCode: 'GOOGLE_API_FAILED', ...(err instanceof GoogleApiError ? { errorCode: `GOOGLE_${err.step.toUpperCase()}`, status: err.status } : { errorName: (err as Error)?.name }) });
      throw new DependencyUnavailableError('google');
    }
  }

  /**
   * Stores the verified state. One purchase belongs to one live account: another live account claiming it
   * gets 409; a purchase whose account was deleted moves to the account restoring it, and that is audited.
   * A revoked purchase stays revoked whatever a later verify says.
   */
  private async record(
    userId: string,
    p: { store: Store; productId: string; digest: string; environment: 'production' | 'sandbox'; state: PurchaseState; purchasedAt: Date | null; requestId?: string },
  ): Promise<PurchaseView> {
    return this.db.transaction(async (query) => {
      await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`purchase:${p.store}:${p.digest}`]);
      const [existing] = await query<Row>(
        `SELECT p.*, u.status AS owner_status FROM purchases p JOIN users u ON u.id = p.user_id WHERE p.store = $1 AND p.external_digest = $2`,
        [p.store, p.digest],
      );
      if (existing && existing.user_id !== userId && existing.owner_status !== 'deleted') throw new ApiError(HttpStatus.CONFLICT, 'PURCHASE_CONFLICT');
      const state: PurchaseState = existing?.state === 'revoked' ? 'revoked' : p.state;
      let row: Row;
      if (!existing) {
        [row] = await query<Row>(
          `INSERT INTO purchases (user_id, store, product_id, external_digest, environment, state, purchased_at, verified_at, revoked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $6 = 'verified' THEN now() END, CASE WHEN $6 = 'revoked' THEN now() END) RETURNING *`,
          [userId, p.store, p.productId, p.digest, p.environment, state, p.purchasedAt],
        );
      } else {
        [row] = await query<Row>(
          `UPDATE purchases SET user_id = $2, state = $3, checked_at = now(),
                  verified_at = CASE WHEN $3 = 'verified' THEN COALESCE(verified_at, now()) ELSE verified_at END,
                  revoked_at = CASE WHEN $3 = 'revoked' THEN COALESCE(revoked_at, now()) ELSE revoked_at END
            WHERE id = $1 RETURNING *`,
          [existing.id, userId, state],
        );
      }
      const changed = !existing || existing.state !== state || existing.user_id !== userId;
      if (changed) {
        await writeAudit(query, {
          actor: `user:${userId}`,
          action: `purchase.${state}`,
          targetType: 'purchase',
          targetId: row.id,
          changes: { store: p.store, productId: p.productId, environment: p.environment, ...(existing && existing.user_id !== userId ? { fromDeletedAccount: true } : {}) },
          requestId: p.requestId,
        });
      }
      return view(row);
    });
  }

  /** Marks a purchase revoked after a refund or revocation reported by the store. Unknown purchases are ignored. */
  private async revoke(store: Store, digest: string, reason: string): Promise<boolean> {
    return this.db.transaction(async (query) => {
      const [row] = await query<Row>(
        `UPDATE purchases SET state = 'revoked', revoked_at = COALESCE(revoked_at, now()), checked_at = now()
          WHERE store = $1 AND external_digest = $2 AND state <> 'revoked' RETURNING *`,
        [store, digest],
      );
      if (!row) return false;
      await writeAudit(query, { actor: `system:${store}`, action: 'purchase.revoked', targetType: 'purchase', targetId: row.id, changes: { store, productId: row.product_id, reason } });
      return true;
    });
  }

  /**
   * Runs `work` the first time a notification id is seen; a redelivery is acknowledged without work.
   * If the work fails the id is forgotten again, so the store's redelivery retries it (the work is idempotent).
   */
  private async once(store: Store, id: string, kind: string, work: () => Promise<void>): Promise<void> {
    const digest = digestOf(store, id);
    const rows = await this.db.query(`INSERT INTO store_notifications (store, digest, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING 1`, [store, digest, kind.slice(0, 64)]);
    if (rows.length === 0) return;
    try {
      await work();
    } catch (err) {
      await this.db.query(`DELETE FROM store_notifications WHERE store = $1 AND digest = $2`, [store, digest]).catch(() => undefined);
      throw err;
    }
  }

  /** App Store Server Notifications V2. Only REFUND and REVOKE change anything here. */
  async appleNotification(body: unknown): Promise<void> {
    const cfg = this.config.billing.apple;
    if (!cfg) throw this.notConfigured('apple');
    if (!isObject(body) || typeof body.signedPayload !== 'string') throw invalid('signedPayload', 'must_be_jws');
    let n: AppleNotification;
    let tx: AppleTransaction | null = null;
    try {
      n = await verifyAppleJws<AppleNotification>(body.signedPayload, cfg.rootCaPem);
      if (n.data?.signedTransactionInfo) tx = await verifyAppleJws<AppleTransaction>(n.data.signedTransactionInfo, cfg.rootCaPem);
    } catch (err) {
      if (err instanceof AppleSignatureError) throw new ApiError(HttpStatus.UNAUTHORIZED, 'AUTH_REQUIRED');
      throw err;
    }
    if (n.data?.bundleId !== cfg.bundleId || typeof n.notificationUUID !== 'string') throw refused('wrong_app');
    // The same rule as verify: a notification from an environment this server does not accept (Sandbox in
    // production) is acknowledged so Apple stops resending it, and changes nothing.
    if (!cfg.environments.includes(n.data?.environment as 'Production')) {
      this.logger.log('INFO', { eventCode: 'APPLE_NOTIFICATION_IGNORED', errorCode: 'ENVIRONMENT' });
      return;
    }
    await this.once('apple', n.notificationUUID, n.notificationType, async () => {
      if ((n.notificationType === 'REFUND' || n.notificationType === 'REVOKE') && tx?.originalTransactionId) {
        await this.revoke('apple', digestOf('apple', tx.originalTransactionId), n.notificationType.toLowerCase());
      }
    });
  }

  /** Google Play real-time developer notifications via Pub/Sub push. */
  async googleNotification(authorization: string | undefined, body: unknown): Promise<void> {
    const cfg = this.config.billing.google;
    if (!cfg || !this.google) throw this.notConfigured('google');
    if (!(await verifyPubSubToken(authorization, this.pushKeys, cfg))) throw new ApiError(HttpStatus.UNAUTHORIZED, 'AUTH_REQUIRED');
    const msg = isObject(body) && isObject(body.message) ? body.message : null;
    if (!msg || typeof msg.messageId !== 'string' || typeof msg.data !== 'string') throw invalid('message', 'malformed');
    let n: DeveloperNotification;
    try {
      n = JSON.parse(Buffer.from(msg.data, 'base64').toString('utf8')) as DeveloperNotification;
    } catch {
      throw invalid('message.data', 'malformed');
    }
    if (n.packageName !== cfg.packageName) throw refused('wrong_app');
    const kind = n.voidedPurchaseNotification ? 'voided' : n.oneTimeProductNotification ? `one_time_${n.oneTimeProductNotification.notificationType}` : 'other';
    await this.once('google', msg.messageId, kind, () => this.googleWork(n, cfg));
  }

  private async googleWork(n: DeveloperNotification, cfg: NonNullable<AppConfig['billing']['google']>): Promise<void> {
    const voided = n.voidedPurchaseNotification?.purchaseToken;
    if (typeof voided === 'string') {
      await this.revoke('google', digestOf('google', voided), 'voided');
      return;
    }
    const one = n.oneTimeProductNotification;
    if (typeof one?.purchaseToken !== 'string' || typeof one.sku !== 'string') return;
    const digest = digestOf('google', one.purchaseToken);
    const [row] = await this.db.query<Row>(`SELECT * FROM purchases WHERE store = 'google' AND external_digest = $1`, [digest]);
    if (!row || row.state !== 'pending') return;
    // 1 = purchased (a pending purchase completed), 2 = cancelled (it never completed).
    if (one.notificationType === 2) {
      await this.revoke('google', digest, 'pending_cancelled');
    } else if (one.notificationType === 1 && cfg.productIds.includes(one.sku)) {
      const purchase = await this.googleCall(() => this.google!.getProduct(one.sku!, one.purchaseToken!));
      if (purchase?.purchaseState !== 0) return;
      const result = await this.record(row.user_id, { store: 'google', productId: one.sku, digest, environment: row.environment, state: 'verified', purchasedAt: row.purchased_at });
      await this.acknowledgeIfNeeded(result, purchase, one.sku, one.purchaseToken);
    }
  }
}

@Controller('v1')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** The account's purchases and Pro state per store. */
  @Get('me/entitlements')
  @UseGuards(AuthGuard)
  async entitlements(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.billing.entitlements(req.actor!.userId);
  }

  /** The app sends the store's proof after a purchase or restore; the server verifies it with the store. Idempotent. */
  @Post('billing/verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  async verify(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<PurchaseView> {
    res.setHeader('Cache-Control', 'no-store');
    return this.billing.verify(req.actor!.userId, parseVerify(body), req.requestId);
  }

  /** App Store Server Notifications V2. No user token: the signed payload is the proof. */
  @Post('webhooks/apple')
  @HttpCode(HttpStatus.OK)
  async apple(@Body() body: unknown): Promise<{ ok: true }> {
    await this.billing.appleNotification(body);
    return { ok: true };
  }

  /** Google Play notifications via Pub/Sub push, authenticated by Google's OIDC token. */
  @Post('webhooks/google')
  @HttpCode(HttpStatus.NO_CONTENT)
  async google(@Headers('authorization') authorization: string | undefined, @Body() body: unknown): Promise<void> {
    await this.billing.googleNotification(authorization, body);
  }
}
