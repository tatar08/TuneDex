-- Community radio directory (Radio Browser): a place staff set for a station by hand, because Radio Browser has
-- coordinates for few stations in some countries (Tar 2026-10-10: Thailand 14 of 77). Used on the web map instead
-- of Radio Browser's own. Changes are audited (directory.geo.*).
CREATE TABLE directory_geo (
  station_id  text PRIMARY KEY CHECK (station_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  lat         numeric(7, 4) NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon         numeric(8, 4) NOT NULL CHECK (lon BETWEEN -180 AND 180),
  updated_by  uuid NOT NULL REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
