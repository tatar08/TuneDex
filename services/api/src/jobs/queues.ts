import { DELETION_DEADLINE_DAYS } from '../account/account';
import { SESSION_END_WINDOW_DAYS } from '../devices/devices.service';

export type JobKind = 'account_deletion' | 'account_export' | 'idp_session_end';
export type JobState = 'pending' | 'retrying' | 'dead_letter' | 'completed';
export const JOB_KINDS: JobKind[] = ['account_deletion', 'account_export', 'idp_session_end'];

/**
 * Every background queue as one row shape (Doc 17 job_outbox view), for /admin/jobs and the alerts. Columns: id,
 * kind, state, requested_at, attempts, last_attempt_at, next_attempt_at, last_error_code, completed_at, deadline and
 * due (when an open job should run next; dead-lettered and completed jobs have none).
 *
 * Ids are opaque and hold no user id: a deletion is its ticket hash, an export `ex_<export id>`, a session end
 * `se_<sha256 of user id:device id>`. The session-end queue is left out when no Keycloak admin client is set up,
 * because nothing is ever called then.
 */
export function jobsCte(withSessionEnds: boolean): string {
  return `WITH jobs AS (
    SELECT ticket_hash AS id, 'account_deletion' AS kind,
           CASE status WHEN 'failed' THEN 'retrying' ELSE status END AS state,
           requested_at, attempts, last_attempt_at, next_attempt_at, last_error_code, completed_at,
           requested_at + interval '${DELETION_DEADLINE_DAYS} days' AS deadline,
           CASE WHEN status IN ('pending', 'failed') THEN coalesce(next_attempt_at, requested_at) END AS due
      FROM account_deletions
    UNION ALL
    SELECT 'ex_' || id::text, 'account_export',
           CASE WHEN status = 'ready' THEN 'completed' WHEN status = 'dead_letter' THEN 'dead_letter'
                WHEN next_attempt_at IS NOT NULL THEN 'retrying' ELSE 'pending' END,
           requested_at, attempts, last_attempt_at, next_attempt_at, last_error_code, ready_at, NULL::timestamptz,
           CASE WHEN status = 'pending' THEN coalesce(next_attempt_at, requested_at) END
      FROM account_exports WHERE expires_at > now()
    ${
      withSessionEnds
        ? `UNION ALL
    SELECT 'se_' || encode(sha256(convert_to(user_id::text || ':' || id::text, 'UTF8')), 'hex'), 'idp_session_end',
           CASE WHEN idp_session_ended_at IS NOT NULL THEN 'completed' WHEN idp_session_dead_at IS NOT NULL THEN 'dead_letter'
                WHEN idp_session_attempts > 0 THEN 'retrying' ELSE 'pending' END,
           revoked_at, idp_session_attempts, idp_session_last_attempt_at, idp_session_next_attempt_at, idp_session_error_code,
           idp_session_ended_at, NULL::timestamptz,
           CASE WHEN idp_session_ended_at IS NULL AND idp_session_dead_at IS NULL THEN coalesce(idp_session_next_attempt_at, revoked_at) END
      FROM devices
     WHERE revoked_at IS NOT NULL AND idp_session_id IS NOT NULL AND revoked_at > now() - interval '${SESSION_END_WINDOW_DAYS} days'`
        : ''
    }
  )`;
}
