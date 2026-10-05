-- Doc 17: support sees a customer's (already redacted) diagnostic reports only when the customer grants it.
-- The customer makes a one-time code (valid 1 hour) and reads it out; the support member who enters it,
-- with a reason, can read that customer's reports for 7 days. The customer can withdraw it at any time.
-- Only a digest of the code is stored.

CREATE TABLE support_access_codes (
  code_hash    text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  redeemed_at  timestamptz
);
CREATE INDEX support_access_codes_user ON support_access_codes (user_id);

CREATE TABLE support_access_grants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  staff_user_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reason         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz
);
CREATE INDEX support_access_grants_user ON support_access_grants (user_id, staff_user_id);
