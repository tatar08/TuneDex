-- Staff roles, the radio station catalog and an append-only audit trail (Doc 17).

-- Roles are granted per account by an operator (scripts/staff.ts), never self-service.
-- A role is active while revoked_at is NULL; history is kept.
CREATE TABLE staff_roles (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('support', 'catalog_editor', 'operator', 'admin', 'auditor')),
  granted_by  text NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE UNIQUE INDEX staff_roles_active ON staff_roles (user_id, role) WHERE revoked_at IS NULL;

-- Each station has one working draft (edited by catalog staff, versioned by `revision`) and,
-- once approved, a published snapshot that is the only thing the public catalog serves.
CREATE TABLE radio_stations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft               jsonb NOT NULL,
  revision            bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by          uuid NOT NULL REFERENCES users(id),
  updated_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Everyone who changed the draft since it was last published; none of them may publish it (two-person rule).
  pending_authors     uuid[] NOT NULL DEFAULT '{}',
  published           jsonb,
  published_revision  bigint,
  published_by        uuid REFERENCES users(id),
  published_at        timestamptz,
  -- Copied out of the published snapshot so the public query can drop expired rights without parsing JSON.
  rights_expires_at   timestamptz,
  disabled_at         timestamptz,
  CHECK ((published IS NULL) = (published_revision IS NULL))
);
CREATE INDEX radio_stations_public ON radio_stations (id) WHERE published IS NOT NULL AND disabled_at IS NULL;

CREATE TABLE audit_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor        text NOT NULL,
  action       text NOT NULL,
  target_type  text NOT NULL,
  target_id    text NOT NULL,
  reason       text,
  changes      jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id   text
);
CREATE INDEX audit_events_target ON audit_events (target_type, target_id, occurred_at);

-- Audit rows can be added, never changed or removed by the application.
CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
