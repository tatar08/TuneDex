-- Account sync (Doc 06 backend sync contract, R1): favorites of public catalog stations and their order.
-- Each entity has a server revision used for compare-and-set; a delete leaves a tombstone so other devices learn
-- about it. `seq` comes from one global sequence and is bumped on every change, so a device pulls "everything
-- after the cursor I last saved". Tombstones older than 90 days are removed and the account's horizon moves
-- forward; a cursor behind the horizon must start over (410).

CREATE SEQUENCE sync_seq;

CREATE TABLE synced_entities (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_id   uuid NOT NULL,
  type        text NOT NULL CHECK (type IN ('favorite')),
  revision    bigint NOT NULL CHECK (revision >= 1),
  value       jsonb,
  deleted_at  timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  seq         bigint NOT NULL DEFAULT nextval('sync_seq'),
  PRIMARY KEY (user_id, entity_id),
  CHECK ((deleted_at IS NULL) = (value IS NOT NULL))
);
CREATE INDEX synced_entities_pull ON synced_entities (user_id, seq);
-- One live favorite per station and account; a second device favoriting the same station gets a conflict.
CREATE UNIQUE INDEX synced_entities_favorite_station ON synced_entities (user_id, (value->>'stationId'))
  WHERE type = 'favorite' AND deleted_at IS NULL;

-- Replays of the same changeId return the first result. A changeId reused with a different body is refused.
CREATE TABLE sync_changes (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  change_id   uuid NOT NULL,
  body_hash   text NOT NULL,
  result      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, change_id)
);
CREATE INDEX sync_changes_age ON sync_changes (created_at);

-- The highest seq whose tombstone has been removed for the account; pulls from a cursor below it get 410.
CREATE TABLE sync_horizons (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  purged_seq   bigint NOT NULL
);

-- When each device last finished a push or pull, shown to the owner on /app/overview.
ALTER TABLE devices ADD COLUMN last_synced_at timestamptz;
