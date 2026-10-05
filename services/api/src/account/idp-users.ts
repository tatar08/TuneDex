import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config';

/** Tests only: stands in for the network. Production uses the global fetch. */
export const IDP_FETCH = Symbol('IDP_FETCH');
export type IdpFetch = typeof fetch;

export type IdpDeleteResult = 'deleted' | 'already_gone' | 'not_configured';

/** A failed call to the identity provider. Carries the HTTP status only, never a body or token. */
export class IdpError extends Error {
  override name = 'IdpError';
  constructor(readonly step: 'token' | 'delete' | 'session' | 'lookup', readonly status: number) {
    super(`identity provider ${step} failed (${status})`);
  }
}

/**
 * Deletes the sign-in identity at Keycloak when an account is deleted (Tar's decision A, 2026-10-04).
 * Uses a confidential client's service account (client credentials). Keycloak's user id is the token `sub`.
 * A user that is already gone counts as done, so a purge that failed later can be retried safely.
 */
@Injectable()
export class IdpUsersService {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(IDP_FETCH) private readonly http: IdpFetch,
  ) {}

  async deleteUser(subject: string): Promise<IdpDeleteResult> {
    const admin = this.config.idpAdmin;
    if (!admin) return 'not_configured';
    const res = await this.admin('DELETE', `${admin.adminBase}/users/${encodeURIComponent(subject)}`);
    if (res.status === 404) return 'already_gone';
    if (!res.ok) throw new IdpError('delete', res.status);
    return 'deleted';
  }

  /**
   * Ends one Keycloak session (online and offline), so the signed-out phone's refresh token stops working at
   * Keycloak too. A session that is already gone counts as ended.
   */
  async endSession(sid: string): Promise<'ended' | 'not_configured'> {
    const admin = this.config.idpAdmin;
    if (!admin) return 'not_configured';
    for (const offline of [false, true]) {
      const res = await this.admin('DELETE', `${admin.adminBase}/sessions/${encodeURIComponent(sid)}${offline ? '?isOffline=true' : ''}`);
      if (!res.ok && res.status !== 404) throw new IdpError('session', res.status);
    }
    return 'ended';
  }

  /** Whether Keycloak still has this user. Only a 404 counts as missing; any other failure throws. */
  async userExists(subject: string): Promise<boolean> {
    const admin = this.config.idpAdmin!;
    const res = await this.admin('GET', `${admin.adminBase}/users/${encodeURIComponent(subject)}`);
    if (res.status === 404) return false;
    if (!res.ok) throw new IdpError('lookup', res.status);
    return true;
  }

  /**
   * Whether the user has a one-time-code (TOTP) credential. Staff roles are only granted to people who set one
   * up, because the realm does not let a password-only sign-in enroll a new code during the MFA step.
   */
  async hasOtp(subject: string): Promise<boolean> {
    const admin = this.config.idpAdmin!;
    const res = await this.admin('GET', `${admin.adminBase}/users/${encodeURIComponent(subject)}/credentials`);
    if (!res.ok) throw new IdpError('lookup', res.status);
    const creds = (await res.json()) as unknown;
    return Array.isArray(creds) && creds.some((c) => typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'otp');
  }

  /** A cached token Keycloak no longer accepts (revoked, keys rotated, server rebuilt) is replaced and the call retried once. */
  private async admin(method: 'GET' | 'DELETE', url: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.http(url, { method, headers: { Authorization: `Bearer ${await this.accessToken()}` }, signal: AbortSignal.timeout(10_000) });
      if (res.status !== 401 || attempt > 0) return res;
      this.token = null;
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const admin = this.config.idpAdmin!;
    const res = await this.http(admin.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${encodeURIComponent(admin.clientId)}:${encodeURIComponent(admin.clientSecret)}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new IdpError('token', res.status);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') throw new IdpError('token', res.status);
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 60;
    // Renew 30 s early so a token never expires between the check and the call.
    this.token = { value: body.access_token, expiresAt: Date.now() + Math.max(ttl - 30, 0) * 1000 };
    return this.token.value;
  }
}
