#!/usr/bin/env bash
# After a deploy: checks the three public names from outside, with normal certificate checks (no -k).
# Needs no secrets and changes nothing. Usage: ./smoke.sh staging.example.com
set -uo pipefail
domain="${1:?usage: smoke.sh <DOMAIN>}"
fail=0
check() { # name, expected, actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected $2, got $3"; fail=1; fi
}
code() { local c; c="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null)"; [ "${c:-000}" = 000 ] && c="no-answer"; echo "$c"; }

check "api ready"                       200 "$(code "https://api.${domain}/health/ready")"
check "signed config"                   200 "$(code "https://api.${domain}/v1/config")"
check "api refuses a call without token" 401 "$(code "https://api.${domain}/v1/me")"
issuer="$(curl -sS --max-time 15 "https://auth.${domain}/realms/tunedeck/.well-known/openid-configuration" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("issuer",""))' 2>/dev/null || true)"
check "keycloak issuer"                 "https://auth.${domain}/realms/tunedeck" "$issuer"
check "keycloak admin closed"           404 "$(code "https://auth.${domain}/admin/master/console/")"
check "keycloak admin API closed"       404 "$(code "https://auth.${domain}/admin/realms/tunedeck/users")"
check "console sign-in page"            200 "$(code "https://console.${domain}/login")"
check "http redirects to https"         308 "$(code "http://api.${domain}/health/ready")"
hsts="$(curl -sS -D - -o /dev/null --max-time 15 "https://api.${domain}/health/live" 2>/dev/null | tr -d '\r' | grep -ci '^strict-transport-security:')"
check "HSTS header"                     1 "${hsts:-0}"
exit "$fail"
