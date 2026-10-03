-- Operational log lines kept for staff search (Doc 17 /admin/logs). Same redacted fields as stdout;
-- no headers, bodies, query strings, emails or tokens. Rows older than 14 days are deleted by the API.
CREATE TABLE operational_logs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  logged_at    timestamptz NOT NULL,
  severity     text NOT NULL CHECK (severity IN ('DEBUG', 'INFO', 'WARN', 'ERROR')),
  service      text NOT NULL,
  environment  text NOT NULL,
  build        text NOT NULL,
  event_code   text NOT NULL,
  request_id   text,
  method       text,
  route        text,
  status       integer,
  duration_ms  integer,
  actor_id     text,
  error_name   text,
  error_code   text
);
CREATE INDEX operational_logs_time ON operational_logs (logged_at DESC, id DESC);
CREATE INDEX operational_logs_request ON operational_logs (request_id) WHERE request_id IS NOT NULL;
