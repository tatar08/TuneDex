# Sourced by the backup scripts. pg_env_from_url VAR exports PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
# (and PGSSLMODE etc. from the query string) from the URL in $VAR, so the password never appears on a
# command line, where other users of the machine could read it from the process list.
pg_env_from_url() {
  local exports
  exports="$(python3 - "$1" <<'PY'
import os, shlex, sys, urllib.parse as u
p = u.urlsplit(os.environ[sys.argv[1]])
if p.scheme not in ("postgres", "postgresql"):
    sys.exit(f"{sys.argv[1]}: expected a postgres:// URL")
known = {"sslmode": "PGSSLMODE", "sslrootcert": "PGSSLROOTCERT", "application_name": "PGAPPNAME", "connect_timeout": "PGCONNECT_TIMEOUT"}
env = {"PGHOST": p.hostname, "PGPORT": p.port and str(p.port), "PGUSER": p.username and u.unquote(p.username),
       "PGPASSWORD": p.password and u.unquote(p.password), "PGDATABASE": u.unquote(p.path.lstrip("/")) or None}
for k, v in u.parse_qsl(p.query):
    if k not in known:
        sys.exit(f"{sys.argv[1]}: unsupported URL parameter {k}")
    env[known[k]] = v
for k, v in env.items():
    if v:
        print(f"export {k}={shlex.quote(v)}")
PY
)" || return 1
  eval "$exports"
}
