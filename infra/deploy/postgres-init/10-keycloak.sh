#!/bin/sh
# Runs once, when the data volume is empty: Keycloak gets its own database and owner, apart from TuneDeck's data.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v kcpw="$KEYCLOAK_DB_PASSWORD" -v appdb="$POSTGRES_DB" <<'SQL'
CREATE ROLE keycloak LOGIN PASSWORD :'kcpw';
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
REVOKE CONNECT ON DATABASE :"appdb" FROM PUBLIC;
SQL
