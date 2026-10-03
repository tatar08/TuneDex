-- COL-01: account identity (from verified OIDC subject) and account-level preferences.
-- No password hashes: the OIDC provider owns credentials (Doc 17).

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oidc_subject  text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleting', 'disabled')),
  locale        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_preferences (
  owner_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  schema_version  integer NOT NULL,
  revision        bigint NOT NULL CHECK (revision > 0),
  value           jsonb NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
