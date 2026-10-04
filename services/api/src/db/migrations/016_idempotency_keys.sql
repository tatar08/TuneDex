-- Doc 17: mutation idempotency scoped (actor, route, key) for at least 24 hours.
-- Only digests of the key and the request are kept. The stored response is what the caller
-- already received (for DELETE /me that includes their deletion ticket), and is removed with the account.

CREATE TABLE idempotency_keys (
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scope            text NOT NULL,                 -- "<METHOD> <path>"
  key_hash         text NOT NULL,
  request_hash     text NOT NULL,
  state            text NOT NULL CHECK (state IN ('in_progress', 'done')),
  response_status  integer,
  response_body    jsonb,
  response_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope, key_hash)
);

CREATE INDEX idempotency_keys_created_at ON idempotency_keys (created_at);
