-- Doc 17 staff_roles: who revoked a role, and the role's scope. R1 has one scope, the whole service;
-- the column exists so a narrower scope later is a new allowed value, not a table change.
ALTER TABLE staff_roles
  ADD COLUMN revoked_by text,
  ADD COLUMN scope text NOT NULL DEFAULT 'global' CHECK (scope IN ('global'));
