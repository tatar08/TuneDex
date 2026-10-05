#!/usr/bin/env bash
# Logical backup of the TuneDeck database (custom format), checked by listing its contents.
# Usage: DATABASE_URL=postgres://… ./backup.sh [output-dir]
# This complements, and does not replace, the provider's point-in-time recovery (RPO 15 min, Doc 17).
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL (never printed)}"
out_dir="${1:-.}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="${out_dir%/}/tunedeck-${stamp}.dump"
umask 077
pg_dump --format=custom --no-owner --no-privileges --file="$file" "$DATABASE_URL"
tables="$(pg_restore --list "$file" | grep -c ' TABLE DATA ' || true)"
if [ "$tables" -eq 0 ]; then echo "backup ${file}: no table data, treat as failed" >&2; exit 1; fi
echo "backup ${file}: $(du -h "$file" | cut -f1), ${tables} tables"
# Tell the API a checked backup exists (it alerts when the newest is over 26 hours old). A failure here
# does not fail the backup, which is already written; it is reported so the alert is not a surprise.
bytes="$(wc -c < "$file" | tr -d ' ')"
if ! psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "INSERT INTO backup_runs (tables, bytes) VALUES (${tables}, ${bytes})" >/dev/null 2>&1; then
  echo "backup ${file}: written, but recording it in backup_runs failed (the backup_stale alert may fire)" >&2
fi
