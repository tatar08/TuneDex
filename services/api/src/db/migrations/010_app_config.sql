-- Remote app configuration (Doc 17 /admin/config, Doc 14 "remote config"): one working draft and an
-- append-only list of releases. The apps only ever see the newest release, signed by the API.

CREATE TABLE app_config_draft (
  id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  payload          jsonb NOT NULL,
  revision         bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_by       uuid REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Everyone who changed the draft since the last release; none of them may publish it (two-person rule).
  pending_authors  uuid[] NOT NULL DEFAULT '{}'
);

CREATE TABLE app_config_releases (
  release         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schema_version  integer NOT NULL,
  payload         jsonb NOT NULL,
  -- The draft revision this release was reviewed at; NULL for a rollback, which reuses an earlier release.
  draft_revision  bigint,
  rollback_of     bigint REFERENCES app_config_releases(release),
  published_by    uuid NOT NULL REFERENCES users(id),
  published_at    timestamptz NOT NULL DEFAULT now(),
  -- After this the apps stop trusting the release and fall back to their built-in defaults.
  expires_at      timestamptz NOT NULL,
  reason          text NOT NULL,
  CHECK ((draft_revision IS NULL) <> (rollback_of IS NULL)),
  CHECK (expires_at > published_at)
);

-- Releases are history: the application can add them but never change or remove one.
CREATE FUNCTION app_config_releases_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'app_config_releases is append-only';
END;
$$;
CREATE TRIGGER app_config_releases_no_update BEFORE UPDATE OR DELETE ON app_config_releases
  FOR EACH ROW EXECUTE FUNCTION app_config_releases_append_only();
