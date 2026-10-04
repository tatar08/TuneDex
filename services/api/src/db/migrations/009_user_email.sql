-- Tar (2026-10-04): keep the customer's email so support can find and contact them on /admin/users.
-- Copied from the identity provider's token on sign-in (the provider stays the source of truth); cleared by
-- the account-deletion purge. Never written to logs or the audit trail.
ALTER TABLE users ADD COLUMN email text CHECK (email IS NULL OR length(email) <= 320);
ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT false;
CREATE INDEX users_email ON users (lower(email)) WHERE email IS NOT NULL;
