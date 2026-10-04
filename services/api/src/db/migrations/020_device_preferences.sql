-- Doc 17 device_preferences: per-device overrides of the account settings, allowlisted keys only.
-- A device without a row (or with {}) follows the account. Revisions are per device (If-Match on PUT).

CREATE TABLE device_preferences (
  user_id         uuid NOT NULL,
  device_id       uuid NOT NULL,
  schema_version  integer NOT NULL,
  revision        bigint NOT NULL CHECK (revision >= 1),
  value           jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id),
  FOREIGN KEY (user_id, device_id) REFERENCES devices (user_id, id) ON DELETE CASCADE
);
