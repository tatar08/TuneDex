-- Indexes found missing in the 2026-10-05 performance review (checked with EXPLAIN on 300k users, 1.5M audit
-- events, 3M health checks). Plain CREATE INDEX: these tables are small before launch. On a large live table,
-- build the same index by hand with CONCURRENTLY first; the IF NOT EXISTS then skips it here.

-- Audit search by time window (and the retention delete) instead of a full scan.
CREATE INDEX IF NOT EXISTS audit_events_time ON audit_events (occurred_at DESC, id DESC);

-- Health-check retention delete and the "last published check" alert.
CREATE INDEX IF NOT EXISTS station_health_time ON station_health (checked_at);

-- Sync tombstone purge.
CREATE INDEX IF NOT EXISTS synced_entities_tombstones ON synced_entities (deleted_at) WHERE deleted_at IS NOT NULL;

-- Support lookup by device id (the primary key starts with user_id).
CREATE INDEX IF NOT EXISTS devices_id ON devices (id);

-- Jobs page and alert job: revoked devices whose Keycloak session end is done or pending.
CREATE INDEX IF NOT EXISTS devices_revoked_sessions ON devices (revoked_at) WHERE revoked_at IS NOT NULL AND idp_session_id IS NOT NULL;

-- Staff station list, sorted by name with id as tie-break.
CREATE INDEX IF NOT EXISTS radio_stations_name ON radio_stations ((draft->>'name'), (id::text));

-- Account purge and store-notification pruning.
CREATE INDEX IF NOT EXISTS account_exports_user ON account_exports (user_id);
CREATE INDEX IF NOT EXISTS store_notifications_received ON store_notifications (received_at);
