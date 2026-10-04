-- Doc 17 config rollout: draft → staging → reviewer approval → production, with platform and build targeting.
-- A release is served on one channel (staging for internal test builds, production for everyone) to the
-- platforms and build range in `targets`; other clients ignore it and keep the newest release that fits them.

ALTER TABLE app_config_draft
  ADD COLUMN targets jsonb NOT NULL DEFAULT
    '{"ios":{"include":true,"minBuild":null,"maxBuild":null},"android":{"include":true,"minBuild":null,"maxBuild":null}}';

ALTER TABLE app_config_releases
  ADD COLUMN environment text NOT NULL DEFAULT 'production' CHECK (environment IN ('staging', 'production')),
  ADD COLUMN targets jsonb NOT NULL DEFAULT
    '{"ios":{"include":true,"minBuild":null,"maxBuild":null},"android":{"include":true,"minBuild":null,"maxBuild":null}}',
  -- The staging release a production release promotes (NULL for staging releases, rollbacks and older releases).
  ADD COLUMN staged_release bigint REFERENCES app_config_releases(release),
  -- Who changed the draft for this release, and the different admin who approved it for production.
  ADD COLUMN authors uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN reviewed_by uuid REFERENCES users(id),
  -- Doc 17 emergency single-admin exception: published by one of the authors, reviewed by no one.
  ADD COLUMN emergency boolean NOT NULL DEFAULT false;

CREATE INDEX app_config_releases_channel ON app_config_releases (environment, release DESC);
