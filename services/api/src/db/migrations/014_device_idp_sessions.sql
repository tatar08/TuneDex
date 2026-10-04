-- The Keycloak session (`sid` claim) each phone signs in with, recorded on check-in. Signing a device out from
-- the web ends that session at Keycloak and makes the API refuse tokens that carry it, including tokens the
-- phone refreshes later. `idp_session_ended_at` is set once Keycloak confirmed; until then a retry runs.
ALTER TABLE devices ADD COLUMN idp_session_id text CHECK (idp_session_id ~ '^[A-Za-z0-9._:-]{1,128}$');
ALTER TABLE devices ADD COLUMN idp_session_ended_at timestamptz;
CREATE INDEX devices_idp_session ON devices (user_id, idp_session_id) WHERE idp_session_id IS NOT NULL;
