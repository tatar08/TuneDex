-- Device registry: what each signed-in phone reports about itself, and when the server last saw it.
-- The id is generated on the device; the key includes the owner so ids never collide or leak across accounts.

CREATE TABLE devices (
  user_id                    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                         uuid NOT NULL,
  platform                   text NOT NULL CHECK (platform IN ('ios', 'android')),
  os_major                   integer NOT NULL CHECK (os_major BETWEEN 0 AND 99),
  app_build                  text NOT NULL,
  applied_settings_revision  bigint NOT NULL DEFAULT 0 CHECK (applied_settings_revision >= 0),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  last_seen_at               timestamptz NOT NULL DEFAULT now(),
  revoked_at                 timestamptz,
  PRIMARY KEY (user_id, id)
);
