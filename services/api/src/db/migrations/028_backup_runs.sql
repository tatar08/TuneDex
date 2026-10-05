-- Doc 17 "no successful backup for 24 hours": infra/backup/backup.sh records each checked dump here, so the
-- API can alert when the newest one is too old. Counts only; no file names, hosts or credentials.
CREATE TABLE backup_runs (
  id           bigserial PRIMARY KEY,
  finished_at  timestamptz NOT NULL DEFAULT now(),
  tables       integer NOT NULL CHECK (tables > 0),
  bytes        bigint NOT NULL CHECK (bytes > 0)
);
CREATE INDEX backup_runs_finished ON backup_runs (finished_at DESC);
