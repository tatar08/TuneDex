-- Doc 17 alerts. One row per occurrence: opened when a rule starts firing, closed when it reads healthy again.
-- A rule without enough data reads "unknown" and neither opens nor closes anything.
CREATE TABLE alerts (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                text NOT NULL CHECK (code ~ '^[a-z_]{1,64}$'),
  severity            text NOT NULL CHECK (severity IN ('critical', 'warning')),
  fired_at            timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  -- The reading when it fired and the latest one (a rate, milliseconds or a count; meaning depends on code).
  value               double precision,
  sample              integer,
  fire_notified_at    timestamptz,
  resolve_notified_at timestamptz
);
CREATE UNIQUE INDEX alerts_open ON alerts (code) WHERE resolved_at IS NULL;
CREATE INDEX alerts_recent ON alerts (fired_at DESC);
