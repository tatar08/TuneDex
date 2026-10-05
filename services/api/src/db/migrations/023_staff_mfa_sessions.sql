-- Doc 17: staff sign in with MFA. Keycloak's MFA level lasts 5 minutes, so a refreshed token can drop back to the
-- password level mid-session. The API remembers which Keycloak sessions proved MFA, and for how long a staff
-- session may last (12 hours), so staff pages keep working after the first MFA sign-in without a second code.
CREATE TABLE staff_mfa_sessions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sid     text NOT NULL,
  mfa_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, sid)
);
