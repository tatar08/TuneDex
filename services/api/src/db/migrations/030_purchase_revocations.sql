-- A refund or revocation the store reports before the app ever verified the purchase. Without this, verifying the
-- old (pre-refund) signed transaction afterwards would grant Pro. Keyed like purchases; no account or token stored.
CREATE TABLE purchase_revocations (
  store            text NOT NULL CHECK (store IN ('apple', 'google')),
  external_digest  text NOT NULL,
  reason           text NOT NULL CHECK (length(reason) BETWEEN 1 AND 64),
  revoked_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store, external_digest)
);
