import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { ApiError } from '../common/api-error';

/** Doc 17: revoking a device and deleting the account need a sign-in from the last 5 minutes. */
export const REAUTH_MAX_AGE_SECONDS = 300;

/** Throws 401 REAUTH_REQUIRED unless the access token says the user signed in within REAUTH_MAX_AGE_SECONDS. */
export function requireRecentSignIn(req: Request): void {
  const authTime = req.actor?.authTime;
  if (authTime === undefined || Date.now() / 1000 - authTime > REAUTH_MAX_AGE_SECONDS) {
    throw new ApiError(HttpStatus.UNAUTHORIZED, 'REAUTH_REQUIRED', { maxAgeSeconds: REAUTH_MAX_AGE_SECONDS });
  }
}

/**
 * Doc 17: publishing, rolling back and exporting need MFA within REAUTH_MAX_AGE_SECONDS. Throws 401
 * MFA_REQUIRED otherwise; the console then signs the admin in again with step-up. No-op in dev without STAFF_MFA_ACR.
 */
export function requireRecentMfa(req: Request): void {
  const actor = req.actor;
  if (actor && actor.mfaRequired === false) return;
  if (actor?.mfaAt === undefined || Date.now() / 1000 - actor.mfaAt > REAUTH_MAX_AGE_SECONDS) {
    throw new ApiError(HttpStatus.UNAUTHORIZED, 'MFA_REQUIRED', { maxAgeSeconds: REAUTH_MAX_AGE_SECONDS });
  }
}
