-- Fixed one-minute request counters shared by every API instance (Doc 17 initial limits).
-- UNLOGGED: counters are disposable, a crash just resets the current minute. Keys hold an
-- internal user id or a hash of the client address, never a raw IP.
CREATE UNLOGGED TABLE rate_limit_counters (
  bucket        text NOT NULL,
  window_start  timestamptz NOT NULL,
  hits          integer NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
