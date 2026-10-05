-- Doc 17: POST /me/exports runs as a job; the result is downloadable through a link valid for at most
-- 15 minutes, and the export itself is deleted within 24 hours. Only a digest of the current link is kept.

CREATE TABLE account_exports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  claimed_at       timestamptz,                   -- a worker is building it (taken over after 5 minutes)
  requested_at     timestamptz NOT NULL DEFAULT now(),
  ready_at         timestamptz,
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  payload          jsonb,
  link_hash        text UNIQUE,
  link_expires_at  timestamptz
);

-- One export in progress per account: asking again returns it.
CREATE UNIQUE INDEX account_exports_one_pending ON account_exports (user_id) WHERE status = 'pending';
CREATE INDEX account_exports_expires_at ON account_exports (expires_at);
