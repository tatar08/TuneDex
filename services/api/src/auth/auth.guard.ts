import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { errors, jwtVerify, JWTVerifyGetKey } from 'jose';
import { ApiError, DependencyUnavailableError } from '../common/api-error';
import { APP_CONFIG, AppConfig } from '../config';
import { UsersService } from '../users/users.service';

/** Resolves signing keys for token verification (remote JWKS at runtime, a local key set in tests). */
export const KEY_RESOLVER = Symbol('KEY_RESOLVER');

const TOKEN_ERRORS = [
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
];

/**
 * Verifies the bearer access token (issuer, audience, signature, expiry, algorithm)
 * and derives the actor from the token subject. Fails closed: any doubt is a 401,
 * an unreachable key set is a 503, and nothing is ever accepted unverified.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(KEY_RESOLVER) private readonly keys: JWTVerifyGetKey,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.header('authorization') ?? '';
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
    if (!match) throw new ApiError(HttpStatus.UNAUTHORIZED, 'AUTH_REQUIRED');

    let subject: string;
    let authTime: number | undefined;
    let issuedAt: number | undefined;
    try {
      const { payload } = await jwtVerify(match[1], this.keys, {
        issuer: this.config.oidc.issuer,
        audience: this.config.oidc.audience,
        algorithms: this.config.oidc.algorithms,
        requiredClaims: ['sub', 'exp'],
        clockTolerance: 5,
      });
      subject = payload.sub as string;
      authTime = typeof payload.auth_time === 'number' ? payload.auth_time : undefined;
      issuedAt = typeof payload.iat === 'number' ? payload.iat : undefined;
    } catch (err) {
      if (TOKEN_ERRORS.some((E) => err instanceof E)) {
        throw new ApiError(HttpStatus.UNAUTHORIZED, 'AUTH_REQUIRED');
      }
      throw new DependencyUnavailableError('oidc_jwks');
    }
    if (!subject) throw new ApiError(HttpStatus.UNAUTHORIZED, 'AUTH_REQUIRED');

    const user = await this.users.findOrCreateBySubject(subject, authTime ?? issuedAt);
    // A sign-in from before this identity's account was deleted.
    if (!user) throw new ApiError(HttpStatus.FORBIDDEN, 'ACCOUNT_DELETING');
    if (user.status === 'deleting') throw new ApiError(HttpStatus.FORBIDDEN, 'ACCOUNT_DELETING');
    if (user.status !== 'active') throw new ApiError(HttpStatus.FORBIDDEN, 'AUTH_FORBIDDEN');
    req.actor = { userId: user.id, authTime };
    return true;
  }
}
