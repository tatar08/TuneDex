-- Doc 17: with STATION_CHECK_RUNNER=worker the API never probes streams itself. A staff "check now"
-- becomes a request here; the checker process claims it, probes, records station_health and answers.
CREATE TABLE station_check_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id    uuid NOT NULL REFERENCES radio_stations(id) ON DELETE CASCADE,
  target        text NOT NULL CHECK (target IN ('published', 'draft')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  done_at       timestamptz,
  result        jsonb
);
CREATE INDEX station_check_requests_open ON station_check_requests (requested_at) WHERE claimed_at IS NULL;
