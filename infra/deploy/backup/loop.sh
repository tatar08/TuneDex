#!/usr/bin/env bash
# Runs the backups now and then every BACKUP_INTERVAL_HOURS, and deletes dumps older than BACKUP_KEEP_DAYS
# (Doc 17: kept at most 35 days). Dumps land in /backups (mode 600); copying them off the server is the
# operator's job. A failed round is logged and retried at the next interval; the API's backup_stale alert
# fires if no checked TuneDeck dump is recorded for 26 hours.
set -uo pipefail
: "${DATABASE_URL:?set DATABASE_URL}" "${KEYCLOAK_DATABASE_URL:?set KEYCLOAK_DATABASE_URL}"
interval_h="${BACKUP_INTERVAL_HOURS:-24}"
keep_days="${BACKUP_KEEP_DAYS:-35}"
dir="${BACKUP_DIR:-/backups}"
here="$(dirname "$0")"
# PID 1 in the container: stop promptly on docker stop instead of waiting out the sleep.
trap 'exit 0' TERM INT

# Called as `keycloak_dump || …`, where bash ignores set -e, so every step checks its own result.
keycloak_dump() (
  # shellcheck source=/dev/null
  . "$here/pg-env.sh" || return 1
  pg_env_from_url KEYCLOAK_DATABASE_URL || return 1
  umask 077
  file="${dir}/keycloak-$(date -u +%Y%m%dT%H%M%SZ).dump"
  if ! pg_dump --format=custom --no-owner --no-privileges --file="$file"; then rm -f "$file"; return 1; fi
  tables="$(pg_restore --list "$file" | grep -c ' TABLE DATA ')"
  if [ "${tables:-0}" -eq 0 ]; then echo "backup ${file}: no table data, treat as failed" >&2; rm -f "$file"; return 1; fi
  echo "backup ${file}: $(du -h "$file" | cut -f1), ${tables} tables"
)

while true; do
  "$here/backup.sh" "$dir" || echo "backup: TuneDeck database dump failed" >&2
  keycloak_dump || echo "backup: Keycloak database dump failed" >&2
  find "$dir" -maxdepth 1 -name '*.dump' -type f -mtime "+${keep_days}" -print -delete
  sleep "$(( interval_h * 3600 ))" &
  wait $!
done
