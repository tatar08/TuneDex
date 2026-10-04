-- Doc 17 account deletion. A request marks the account "deleting" (it can no longer sign in), signs every
-- device out and queues a purge. The purge removes settings, devices, diagnostics and staff roles, and cuts
-- the link to the identity provider by replacing the OIDC subject. The users row stays as a pseudonymous
-- tombstone because station history and the audit trail refer to it; it is also the deletion ledger a
-- disaster restore replays (every 'deleted' row must have no data left).
ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'deleting', 'deleted', 'disabled'));
ALTER TABLE users ADD COLUMN deleted_at timestamptz;

-- One row per request. The user polls progress with a random ticket after signing out; only its hash is stored.
-- subject_hash (sha256 of the OIDC subject) lets the API refuse tokens from sign-ins made before the request,
-- so a phone still holding one cannot quietly start a new account; a fresh sign-in after deletion can.
CREATE TABLE account_deletions (
  ticket_hash     text PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id),
  subject_hash    text NOT NULL,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  completed_at    timestamptz
);
CREATE UNIQUE INDEX account_deletions_open ON account_deletions (user_id) WHERE status <> 'completed';
CREATE INDEX account_deletions_subject ON account_deletions (subject_hash);
CREATE INDEX account_deletions_queue ON account_deletions (status, last_attempt_at) WHERE status <> 'completed';
