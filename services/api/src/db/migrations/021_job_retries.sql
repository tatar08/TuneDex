-- Doc 17 worker rule for every background job: retry with exponential backoff (1, 5, 15, then 60 minutes),
-- at most 5 attempts a round, then `dead_letter` until an operator starts a new round from /admin/jobs.
-- `attempts` counts the current round. Error columns hold a short code (IDP_DELETE_FAILED, DB_40001, ...),
-- never a message, body or token.

-- Account deletions: 'failed' stays "failed, retrying". A dead-lettered deletion keeps the account locked
-- ('deleting'), stays on /admin/jobs and keeps the job_dead_letter alert open.
ALTER TABLE account_deletions DROP CONSTRAINT account_deletions_status_check;
ALTER TABLE account_deletions ADD CONSTRAINT account_deletions_status_check CHECK (status IN ('pending', 'failed', 'dead_letter', 'completed'));
ALTER TABLE account_deletions
  ADD COLUMN next_attempt_at  timestamptz,
  ADD COLUMN last_error_code  text CHECK (last_error_code ~ '^[A-Z0-9_]{1,64}$'),
  ADD COLUMN dead_lettered_at timestamptz;
-- Requests that were already failing start a fresh round now, so the upgrade itself dead-letters nothing.
UPDATE account_deletions SET attempts = 0, next_attempt_at = now() WHERE status = 'failed';

-- Account exports: what used to be 'failed' (3 attempts used up) is now 'dead_letter'. Users still read 'failed'.
ALTER TABLE account_exports DROP CONSTRAINT account_exports_status_check;
UPDATE account_exports SET status = 'dead_letter' WHERE status = 'failed';
ALTER TABLE account_exports ADD CONSTRAINT account_exports_status_check CHECK (status IN ('pending', 'ready', 'dead_letter'));
ALTER TABLE account_exports
  ADD COLUMN last_attempt_at  timestamptz,
  ADD COLUMN next_attempt_at  timestamptz,
  ADD COLUMN last_error_code  text CHECK (last_error_code ~ '^[A-Z0-9_]{1,64}$'),
  ADD COLUMN dead_lettered_at timestamptz;

-- Ending a signed-out device's Keycloak session (migration 014). Open sessions start at 0 attempts.
ALTER TABLE devices
  ADD COLUMN idp_session_attempts        integer NOT NULL DEFAULT 0,
  ADD COLUMN idp_session_last_attempt_at timestamptz,
  ADD COLUMN idp_session_next_attempt_at timestamptz,
  ADD COLUMN idp_session_error_code      text CHECK (idp_session_error_code ~ '^[A-Z0-9_]{1,64}$'),
  ADD COLUMN idp_session_dead_at         timestamptz;
CREATE INDEX devices_idp_session_queue ON devices (revoked_at)
  WHERE revoked_at IS NOT NULL AND idp_session_id IS NOT NULL AND idp_session_ended_at IS NULL;
