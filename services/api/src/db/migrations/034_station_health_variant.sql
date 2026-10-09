-- Which endpoint a check probed: 0 is the main stream, 1..3 the published variants in order.
-- Station health (state, suspect, alerts) still comes from the main stream only.
ALTER TABLE station_health ADD COLUMN variant smallint NOT NULL DEFAULT 0 CHECK (variant BETWEEN 0 AND 3);
