-- Doc 17 proposes keeping audit records 180 days. The table stays append-only for the application: rows can
-- never be changed, and a row can be removed only when it is past 180 days and the session has switched on
-- `tunedeck.audit_retention` (only the retention job does, and only when AUDIT_RETENTION_ENABLED=true).
CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('tunedeck.audit_retention', true) = 'on'
     AND OLD.occurred_at < now() - interval '180 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
