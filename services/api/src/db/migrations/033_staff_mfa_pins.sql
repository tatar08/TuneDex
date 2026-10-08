-- Keycloak lets anyone who knows a password enroll a one-time code (during the MFA step or on the account page),
-- so MFA alone does not prove the code belongs to the staff member. The one-time code credentials a staff member
-- had when the role was granted (or last confirmed by an operator) are pinned here; staff requests are refused
-- while Keycloak holds any one-time code that is not pinned.
CREATE TABLE staff_mfa_pins (
  user_id         uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  credential_ids  text[] NOT NULL CHECK (cardinality(credential_ids) > 0),
  pinned_at       timestamptz NOT NULL DEFAULT now(),
  pinned_by       text NOT NULL
);
