-- Station logos (Tar 2026-10-10): a logo staff upload for a community station, shown instead of the Radio Browser
-- favicon, and TuneDeck's own logo, shown for stations with none. Small images only (the console shrinks them to
-- 256 px first); PNG, JPEG or WebP, never SVG. Changes are audited (directory.logo.*, brand.logo.*).
CREATE TABLE logo_images (
  key           text PRIMARY KEY CHECK (key ~ '^station:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR key = 'brand:station-default'),
  content_type  text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  data          bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 65536),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  updated_by    uuid NOT NULL REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
