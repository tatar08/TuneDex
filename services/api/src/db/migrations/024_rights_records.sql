-- Doc 17 rights evidence: each station's rights live in their own records instead of three inline draft fields.
-- A station is publishable only with an active, current record covering its country. Records are revoked, never
-- deleted, so the history of what allowed a station to be served is kept.
CREATE TABLE rights_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id     uuid NOT NULL REFERENCES radio_stations(id) ON DELETE CASCADE,
  -- Who granted the rights (station owner, broadcaster, aggregator).
  holder         text NOT NULL CHECK (length(holder) BETWEEN 1 AND 200),
  basis          text NOT NULL CHECK (basis IN ('owner_permission', 'broadcaster_terms', 'licensed_aggregator', 'owned_demo')),
  -- Where the evidence lives (contract number, ticket, email thread id). Not the evidence itself.
  reference      text NOT NULL CHECK (length(reference) BETWEEN 1 AND 200),
  -- ISO 3166 alpha-2 codes the rights cover.
  territories    text[] NOT NULL CHECK (cardinality(territories) BETWEEN 1 AND 250),
  valid_from     date NOT NULL,
  -- Valid through the whole day (UTC); NULL means no end date. "Expired" is derived from this, never stored.
  expires_at     date CHECK (expires_at IS NULL OR expires_at >= valid_from),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  -- Opaque keys of the evidence files in private storage. Never public URLs, never served to the public catalog.
  evidence_refs  text[] NOT NULL DEFAULT '{}' CHECK (cardinality(evidence_refs) <= 10),
  -- NULL actor columns mean the record was written by this migration.
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES users(id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  revoked_by     uuid REFERENCES users(id),
  revoked_at     timestamptz,
  revoke_reason  text,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoke_reason IS NOT NULL))
);
CREATE INDEX rights_records_station ON rights_records (station_id, created_at);

-- Back-fill one record per station that had a basis and a reference (the two fields the old publish gate required),
-- from the draft or, when the draft's were cleared after publishing, from the published snapshot. The territory is
-- the station's country (draft and published, when they differ); the holder was never recorded.
WITH src AS (
  SELECT id, created_at,
         CASE WHEN draft->>'rightsBasis' IS NOT NULL AND draft->>'rightsReference' IS NOT NULL THEN draft ELSE published END AS r,
         ARRAY(SELECT DISTINCT c FROM unnest(ARRAY[draft->>'country', published->>'country']) AS c WHERE c IS NOT NULL ORDER BY c) AS countries
    FROM radio_stations
)
INSERT INTO rights_records (station_id, holder, basis, reference, territories, valid_from, expires_at)
SELECT id, '[not recorded: migrated]', r->>'rightsBasis', r->>'rightsReference', countries,
       LEAST((created_at AT TIME ZONE 'UTC')::date, COALESCE((r->>'rightsExpiresAt')::date, 'infinity'::date)),
       (r->>'rightsExpiresAt')::date
  FROM src
 WHERE r->>'rightsBasis' IS NOT NULL AND r->>'rightsReference' IS NOT NULL;

-- When the public catalog may serve a station: the end of the latest current, active record covering the station's
-- (published, else draft) country; NULL when one of them has no end date; now() when none covers it, so the
-- station is hidden at once. The API recomputes it on publish and on every rights add or revoke.
CREATE FUNCTION station_rights_until(p_station uuid) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN count(r.id) = 0 THEN now()
              WHEN bool_or(r.expires_at IS NULL) THEN NULL
              ELSE ((max(r.expires_at) + 1)::timestamp AT TIME ZONE 'UTC') - interval '1 millisecond' END
    FROM radio_stations s
    LEFT JOIN rights_records r
      ON r.station_id = s.id AND r.status = 'active'
     AND r.valid_from <= (now() AT TIME ZONE 'UTC')::date
     AND (r.expires_at IS NULL OR r.expires_at >= (now() AT TIME ZONE 'UTC')::date)
     AND COALESCE(s.published->>'country', s.draft->>'country') = ANY (r.territories)
   WHERE s.id = p_station
$$;

UPDATE radio_stations SET rights_expires_at = station_rights_until(id);
COMMENT ON COLUMN radio_stations.rights_expires_at IS 'station_rights_until(id), kept current by the API so the public query needs no join';

-- The rights now live in rights_records only. Revisions are unchanged: this is not an edit of the station.
UPDATE radio_stations
   SET draft = draft - 'rightsBasis' - 'rightsReference' - 'rightsExpiresAt',
       published = published - 'rightsBasis' - 'rightsReference' - 'rightsExpiresAt';
