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
