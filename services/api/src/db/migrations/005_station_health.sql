-- Point-in-time stream checks of published stations (Doc 17 station_health). Not listening data.
-- Holds result codes only, never the stream URL. Rows older than 30 days are deleted by the checker.
CREATE TABLE station_health (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  station_id    uuid NOT NULL REFERENCES radio_stations(id) ON DELETE CASCADE,
  check_region  text NOT NULL,
  checked_at    timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL CHECK (status IN ('ok', 'fail')),
  reason        text NOT NULL,
  http_status   integer,
  latency_ms    integer,
  content_type  text,
  -- 'published' for the scheduled check of the live snapshot, 'draft' for a staff check before publishing.
  target        text NOT NULL DEFAULT 'published' CHECK (target IN ('published', 'draft'))
);
CREATE INDEX station_health_recent ON station_health (station_id, checked_at DESC);
