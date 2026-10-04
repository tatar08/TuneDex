import { importPKCS8, jwtVerify, JWTVerifyGetKey, SignJWT } from 'jose';

/** Fetch used for Google APIs; tests replace it with a fake Google. */
export type GoogleFetch = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

export class GoogleApiError extends Error {
  constructor(
    readonly step: 'token' | 'get' | 'acknowledge',
    readonly status: number,
  ) {
    super(`google ${step} failed (${status})`);
    this.name = 'GoogleApiError';
  }
}

/** The fields of the Play Developer API ProductPurchase resource this service reads. */
export interface ProductPurchase {
  /** 0 purchased, 1 cancelled, 2 pending. */
  purchaseState: number;
  /** 0 not yet acknowledged, 1 acknowledged. */
  acknowledgementState: number;
  purchaseTimeMillis?: string;
  /** Present for test purchases (0 = test). */
  purchaseType?: number;
  obfuscatedExternalAccountId?: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

/** Calls the Play Developer API as the configured service account. Tokens and purchase tokens are never logged. */
export class GooglePlayClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly cfg: { packageName: string; serviceAccount: { clientEmail: string; privateKeyPem: string } },
    private readonly fetchImpl: GoogleFetch,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const key = await importPKCS8(this.cfg.serviceAccount.privateKeyPem, 'RS256');
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.cfg.serviceAccount.clientEmail)
      .setAudience(TOKEN_URL)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(key);
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200) throw new GoogleApiError('token', res.status);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (typeof body.access_token !== 'string') throw new GoogleApiError('token', res.status);
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 };
    return body.access_token;
  }

  private url(productId: string, purchaseToken: string, suffix = '') {
    return `${API}/${encodeURIComponent(this.cfg.packageName)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}${suffix}`;
  }

  /** The purchase as Google records it, or null when Google does not know the token. */
  async getProduct(productId: string, purchaseToken: string): Promise<ProductPurchase | null> {
    const res = await this.fetchImpl(this.url(productId, purchaseToken), { headers: { authorization: `Bearer ${await this.accessToken()}` }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404 || res.status === 400 || res.status === 410) return null;
    if (res.status !== 200) throw new GoogleApiError('get', res.status);
    return (await res.json()) as ProductPurchase;
  }

  /** Acknowledges after the entitlement is stored; Google refunds purchases left unacknowledged for 3 days. */
  async acknowledge(productId: string, purchaseToken: string): Promise<void> {
    const res = await this.fetchImpl(this.url(productId, purchaseToken, ':acknowledge'), {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200 && res.status !== 204) throw new GoogleApiError('acknowledge', res.status);
  }
}

/**
 * Checks the OIDC token Pub/Sub attaches to a push request: signed by Google, for our audience, issued to the
 * configured push service account with a verified email.
 */
export async function verifyPubSubToken(authorization: string | undefined, keys: JWTVerifyGetKey, cfg: { pushAudience: string; pushServiceAccount: string }): Promise<boolean> {
  const m = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(authorization ?? '');
  if (!m) return false;
  try {
    const { payload } = await jwtVerify(m[1], keys, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: cfg.pushAudience, algorithms: ['RS256'] });
    return payload.email === cfg.pushServiceAccount && payload.email_verified === true;
  } catch {
    return false;
  }
}

/** Real-time developer notification payload (inside the Pub/Sub message data) fields this service reads. */
export interface DeveloperNotification {
  packageName?: string;
  oneTimeProductNotification?: { notificationType?: number; purchaseToken?: string; sku?: string };
  voidedPurchaseNotification?: { purchaseToken?: string; productType?: number };
  testNotification?: unknown;
}
