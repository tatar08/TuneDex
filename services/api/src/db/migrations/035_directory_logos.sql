-- Logos staff upload for the community radio directory (Tar 2026-10-10): one per Radio Browser station id, shown
-- instead of the station's own, and 'default', our own logo for stations that have none. Small PNG, JPEG or WebP
-- kept in the row; changes are audited (directory.logo.*).
CREATE TABLE directory_logos (
  key           text PRIMARY KEY CHECK (key = 'default' OR key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  content_type  text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  image         bytea NOT NULL CHECK (octet_length(image) BETWEEN 1 AND 262144),
  version       text NOT NULL CHECK (version ~ '^[0-9a-f]{16}$'),
  updated_by    uuid NOT NULL REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
