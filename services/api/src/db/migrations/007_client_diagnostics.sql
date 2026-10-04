-- Opt-in client diagnostics (Doc 17 POST /diagnostics/batches, Doc 07 event schema).
-- Only allowlisted, non-personal fields: no URLs, channel or playlist names, queries, location or IP.
-- Kept 7 days (Doc 17 retention); the owner can list and delete their own reports.
CREATE TABLE diagnostic_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     uuid NOT NULL,
  batch_id      uuid NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  -- The user agreed to this upload on the device (per-export consent, Doc 10).
  consented     boolean NOT NULL CHECK (consented),
  event_count   integer NOT NULL,
  UNIQUE (user_id, batch_id),
  FOREIGN KEY (user_id, device_id) REFERENCES devices (user_id, id) ON DELETE CASCADE
);
CREATE INDEX diagnostic_reports_owner ON diagnostic_reports (user_id, received_at DESC);
CREATE INDEX diagnostic_reports_device ON diagnostic_reports (user_id, device_id, received_at DESC);
CREATE INDEX diagnostic_reports_age ON diagnostic_reports (received_at);

CREATE TABLE diagnostic_events (
  report_id         uuid NOT NULL REFERENCES diagnostic_reports(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL,
  event_id          uuid NOT NULL,
  event_name        text NOT NULL,
  schema_version    integer NOT NULL,
  monotonic_ms      bigint NOT NULL,
  session_random_id text NOT NULL,
  duration_ms       integer,
  result_code       text,
  network_class     text NOT NULL CHECK (network_class IN ('wifi', 'cellular', 'offline')),
  app_build         text NOT NULL,
  os_major          integer NOT NULL,
  device_class      text NOT NULL CHECK (device_class IN ('phone', 'tablet')),
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX diagnostic_events_report ON diagnostic_events (report_id);
