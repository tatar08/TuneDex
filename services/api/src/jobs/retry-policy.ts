import { IdpError } from '../account/idp-users';

/**
 * Doc 17 worker rule, shared by every background job (account deletion, account export, Keycloak session end):
 * a failed attempt is retried after 1, 5, 15 and then 60 minutes; the 5th failure in a round moves the job to
 * `dead_letter`, where it waits for an operator (POST /v1/admin/jobs/{id}/retry starts a new round).
 * A round takes about 81 minutes from the first failure to the dead letter.
 */
export const MAX_ATTEMPTS = 5;
export const BACKOFF_MINUTES = [1, 5, 15, 60] as const;
/** How often each worker looks for due jobs: shorter than the shortest backoff. */
export const WORKER_TICK_MS = 60_000;

export interface AfterFailure {
  /** Attempts in this round, including the one that just failed. */
  attempts: number;
  /** Seconds until the next try, or null when the job is now dead-lettered. */
  retryInSeconds: number | null;
}

/** What follows a failed attempt, given how many attempts the round had before it. */
export function afterFailure(attemptsBefore: number): AfterFailure {
  const attempts = attemptsBefore + 1;
  if (attempts >= MAX_ATTEMPTS) return { attempts, retryInSeconds: null };
  return { attempts, retryInSeconds: BACKOFF_MINUTES[Math.max(0, attempts - 1)] * 60 };
}

/**
 * A short code for the failure, stored as `last_error_code` and shown on /admin/jobs. Only names and status
 * classes: never an error message, URL, body or token.
 */
export function jobErrorCode(err: unknown): string {
  if (err instanceof IdpError) return `IDP_${err.step.toUpperCase()}_FAILED`;
  const e = err as { name?: unknown; code?: unknown } | null;
  if (typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return `DB_${e.code}`; // PostgreSQL SQLSTATE
  if (typeof e?.code === 'string' && /^E[A-Z]{2,30}$/.test(e.code)) return `SYS_${e.code}`; // ECONNREFUSED, ETIMEDOUT
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'TIMEOUT';
  return 'INTERNAL_ERROR';
}
