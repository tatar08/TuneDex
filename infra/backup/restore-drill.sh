#!/usr/bin/env bash
# Restore drill (Doc 17: before first release, then quarterly). Restores a dump into a throwaway database,
# checks it, prints how long it took, and drops it. Never point ADMIN_DATABASE_URL at production.
# Usage: ADMIN_DATABASE_URL=postgres://…/postgres ./restore-drill.sh tunedeck-….dump
set -euo pipefail
: "${ADMIN_DATABASE_URL:?set ADMIN_DATABASE_URL to a scratch server (never printed)}"
dump="${1:?usage: restore-drill.sh <dump file>}"
db="tunedeck_drill_$(date -u +%Y%m%d%H%M%S)"
target="$(python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(u.urlunsplit(p._replace(path="/"+sys.argv[2])))' "$ADMIN_DATABASE_URL" "$db")"
start=$(date +%s)
psql -q -v ON_ERROR_STOP=1 "$ADMIN_DATABASE_URL" -c "CREATE DATABASE ${db}"
trap 'psql -q "$ADMIN_DATABASE_URL" -c "DROP DATABASE IF EXISTS ${db} WITH (FORCE)" >/dev/null' EXIT
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$target" "$dump"
q() { psql -tA -v ON_ERROR_STOP=1 "$target" -c "$1"; }
echo "restored into ${db} in $(( $(date +%s) - start )) s"
echo "latest migration: $(q "SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1")"
for t in users devices audit_events radio_stations app_config_releases purchases synced_entities; do
  echo "${t}: $(q "SELECT count(*) FROM ${t}") rows"
done
echo "audit rows are still append-only: $(q "SELECT count(*) FROM pg_trigger WHERE tgrelid = 'audit_events'::regclass AND NOT tgisinternal") trigger(s)"
echo "accounts waiting for deletion: $(q "SELECT count(*) FROM users WHERE status = 'deleting'")"
