-- Store purchases (Doc 11, ADR-12): Pro is a one-time product, verified by the server with Apple or Google,
-- store-scoped in R1. Only a digest of the store's purchase identity is kept (Apple originalTransactionId,
-- Google purchaseToken), never the identifier, receipt or payload. The digest is unique per store, so one
-- purchase can belong to one account only; a second account claiming it gets a conflict, never a silent move.
CREATE TABLE purchases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store            text NOT NULL CHECK (store IN ('apple', 'google')),
  product_id       text NOT NULL,
  external_digest  text NOT NULL,
  environment      text NOT NULL CHECK (environment IN ('production', 'sandbox')),
  state            text NOT NULL CHECK (state IN ('verified', 'pending', 'revoked')),
  purchased_at     timestamptz,
  verified_at      timestamptz,
  revoked_at       timestamptz,
  checked_at       timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store, external_digest)
);
CREATE INDEX purchases_owner ON purchases (user_id);

-- Store notifications already handled, so a redelivery does nothing twice. Holds the notification id digest only.
CREATE TABLE store_notifications (
  store         text NOT NULL CHECK (store IN ('apple', 'google')),
  digest        text NOT NULL,
  kind          text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store, digest)
);
