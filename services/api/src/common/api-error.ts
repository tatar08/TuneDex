import { HttpStatus } from '@nestjs/common';

export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_FORBIDDEN'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'EXPORT_NOT_READY'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'PRECONDITION_REQUIRED'
  | 'REVISION_MISMATCH'
  | 'PAYLOAD_TOO_LARGE'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'REAUTH_REQUIRED'
  | 'DEVICE_REVOKED'
  | 'DEVICE_LIMIT'
  | 'ROLE_REQUIRED'
  | 'PUBLISH_BLOCKED'
  | 'CHECK_TOO_SOON'
  | 'CHECKER_UNAVAILABLE'
  | 'RIGHTS_ALREADY_REVOKED'
  | 'API_RATE_LIMITED'
  | 'ACCOUNT_DELETING'
  | 'JOB_RETRY_TOO_SOON'
  | 'JOB_BUSY'
  | 'JOB_RETRY_LIMIT'
  | 'JOB_SUPERSEDED'
  | 'SYNC_RESET_REQUIRED'
  | 'PURCHASE_INVALID'
  | 'PURCHASE_CONFLICT'
  | 'MFA_REQUIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'SUPPORT_ACCESS_REQUIRED'
  | 'INTERNAL';

export const MESSAGE_KEYS: Record<ErrorCode, string> = {
  AUTH_REQUIRED: 'errors.auth.required',
  AUTH_FORBIDDEN: 'errors.auth.forbidden',
  VALIDATION_FAILED: 'errors.request.invalid',
  NOT_FOUND: 'errors.request.notFound',
  EXPORT_NOT_READY: 'errors.export.notReady',
  IDEMPOTENCY_KEY_REQUIRED: 'errors.request.idempotencyKeyRequired',
  PRECONDITION_REQUIRED: 'errors.request.ifMatchRequired',
  REVISION_MISMATCH: 'errors.settings.revisionMismatch',
  PAYLOAD_TOO_LARGE: 'errors.request.tooLarge',
  DEPENDENCY_UNAVAILABLE: 'errors.service.unavailable',
  REAUTH_REQUIRED: 'errors.auth.reauthRequired',
  DEVICE_REVOKED: 'errors.devices.revoked',
  DEVICE_LIMIT: 'errors.devices.limit',
  ROLE_REQUIRED: 'errors.auth.roleRequired',
  PUBLISH_BLOCKED: 'errors.stations.publishBlocked',
  CHECK_TOO_SOON: 'errors.stations.checkTooSoon',
  CHECKER_UNAVAILABLE: 'errors.stations.checkerUnavailable',
  RIGHTS_ALREADY_REVOKED: 'errors.stations.rightsAlreadyRevoked',
  API_RATE_LIMITED: 'errors.request.rateLimited',
  ACCOUNT_DELETING: 'errors.account.deleting',
  JOB_RETRY_TOO_SOON: 'errors.jobs.retryTooSoon',
  JOB_BUSY: 'errors.jobs.busy',
  JOB_RETRY_LIMIT: 'errors.jobs.retryLimit',
  JOB_SUPERSEDED: 'errors.jobs.superseded',
  SYNC_RESET_REQUIRED: 'errors.sync.resetRequired',
  PURCHASE_INVALID: 'errors.billing.invalid',
  PURCHASE_CONFLICT: 'errors.billing.ownedByAnotherAccount',
  MFA_REQUIRED: 'errors.auth.mfaRequired',
  IDEMPOTENCY_KEY_REUSED: 'errors.request.idempotencyKeyReused',
  IDEMPOTENCY_IN_PROGRESS: 'errors.request.inProgress',
  SUPPORT_ACCESS_REQUIRED: 'errors.support.accessRequired',
  INTERNAL: 'errors.service.internal',
};

/** An error that maps to the `{code,messageKey,requestId,details}` envelope. Details must not hold tokens or PII. */
export class ApiError extends Error {
  constructor(
    readonly status: HttpStatus,
    readonly code: ErrorCode,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

export class DependencyUnavailableError extends ApiError {
  constructor(readonly dependency: string) {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'DEPENDENCY_UNAVAILABLE');
  }
}
