-- The rights sweep looks up records that started in the last week, and stations hidden now.
CREATE INDEX IF NOT EXISTS rights_records_valid_from ON rights_records (valid_from) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS radio_stations_rights_expires ON radio_stations (rights_expires_at);
