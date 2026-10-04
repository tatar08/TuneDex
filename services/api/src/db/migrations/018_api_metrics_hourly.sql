-- Doc 17 GET /admin/metrics: hourly API request counts per route template, kept 90 days (raw log lines
-- only 14). Labels are method and route template only: never user, station or request ids.
-- latency_buckets counts requests by duration, upper bounds in ms: 50, 100, 250, 500, 1000, 2500, 5000, more.

CREATE TABLE api_metrics_hourly (
  hour             timestamptz NOT NULL,
  method           text NOT NULL,
  route            text NOT NULL,
  requests         integer NOT NULL,
  server_errors    integer NOT NULL,
  client_errors    integer NOT NULL,
  latency_buckets  integer[] NOT NULL CHECK (cardinality(latency_buckets) = 8),
  PRIMARY KEY (hour, method, route)
);
