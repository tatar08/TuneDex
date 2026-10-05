-- Community radio directory (Radio Browser): stations staff have taken out of the search results, by Radio
-- Browser station id or by stream host (the host and every subdomain). Changes are audited (directory.block.*).
CREATE TABLE directory_blocks (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('station', 'host')),
  value       text NOT NULL CHECK (length(value) BETWEEN 1 AND 253),
  reason      text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);
