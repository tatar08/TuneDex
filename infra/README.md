# TuneDeck backend infrastructure

Backend and web only (Doc 19: Claude's `services/**`, `apps/console/**` and scoped infra). The mobile apps and root CI are Codex's.

## Images

- `services/api/Dockerfile`: Node 22, production dependencies only, runs as the unprivileged `node` user, health check on `/health/live`. Before starting a new release, run migrations once with the same image: `node dist/db/migrate.js`.
- `apps/console/Dockerfile`: the Next.js build plus `next start` on port 3200, also as `node`. The build downloads the Google fonts once (`next/font`), so the build machine needs internet access. Staff browsers never call Google.

Both read every setting from the environment. Each package's `.env.example` lists the variables, and no secrets are baked into an image.

## Local stack (`infra/compose`)

```sh
cd infra/compose
cp .env.example .env        # replace every CHANGE_ME, e.g. with `openssl rand -hex 24`
docker compose up --build
```

- Console: http://localhost:3200. Keycloak: http://keycloak.localhost:8080 (admin console under `/admin`, user `admin`, password from `.env`). API: http://localhost:3100. Ports differ if you set `API_HOST_PORT` / `CONSOLE_HOST_PORT` in `.env` (set them before the first start: Keycloak takes the console URL from its realm import).
- Browsers send `*.localhost` to this machine, and inside the compose network the same name points at the Keycloak container, so the browser, the API and the console all see one issuer. Chrome, Edge and Firefox do this without setup. If a browser cannot open `keycloak.localhost`, add `127.0.0.1 keycloak.localhost` to the hosts file.
- The realm (`keycloak/tunedeck-realm.json`) is imported on the first start only. To start over, run `docker compose down -v`. It contains:
  - The `tunedeck-console` confidential client (PKCE S256, its redirect and logout URLs come from `.env`) with the `tunedeck-api` audience on access tokens.
  - The `tunedeck-api-admin` service account with `realm-management` / `manage-users`. The API uses it to delete Keycloak users on account deletion and to end a signed-out phone's session.
  - The browser flow `browser with mfa step-up`:
    - Level 1 (`acr` = `password`) asks for the password.
    - Level 2 (`acr` = `mfa`) also asks for a one-time code (TOTP). Keycloak 26 lets anyone who signs in with only the password enroll a new code there (and on the account page); the OTP Form's "user setup" setting has no effect. So the API pins each staff member's codes: `staff-cli grant` refuses anyone without a code (set it up first at `/realms/tunedeck/account` → Signing in → Authenticator application) and records the codes they have, and every staff request is refused with 403 `STAFF_MFA_CHANGED` while the account holds a code that was not pinned. Staff granted before pins existed get their current codes pinned on their first MFA request (audited as `staff_mfa.pin`). After a legitimate change (new phone, reset), check with the person, then run `npm run staff -- pin-mfa <oidc-subject> --by <you> --reason "<why>"`.
    - The API's `STAFF_MFA_ACR` and the console's `OIDC_MFA_ACR` are both `mfa`.
  - A user profile with only username and email (no name fields), registration by email, a 12-character minimum password, and brute-force protection.
  - The `tunedeck` login theme (`infra/keycloak/themes/tunedeck`, mounted read-only) and Thai/English pages, Thai by default. The console passes the visitor's language (`ui_locales`). On a realm imported before this, set it once: `docker compose exec keycloak /opt/keycloak/bin/kcadm.sh update realms/tunedeck -s loginTheme=tunedeck -s internationalizationEnabled=true -s 'supportedLocales=["th","en"]' -s defaultLocale=th --server http://localhost:8080 --realm master --user admin --password "$KEYCLOAK_ADMIN_PASSWORD"`.
  - The mobile app's client is not in this file: its redirect URI and client type are Codex's to decide.
- Staff roles: sign in once, then `docker compose exec api node dist/staff/staff-cli.js grant <subject> admin --by <you> --reason "<why>"`. The subject is the Keycloak user id.
- Postgres listens on 127.0.0.1:5432 (user `tunedeck`, password from `.env`); set `POSTGRES_HOST_PORT` (e.g. 55432) in `.env` when the machine already runs its own Postgres there. Containers still reach it as `postgres:5432`. Console sessions live in memory here because the base URL is localhost.

Checked on 2026-10-04 against Keycloak 26.4, with the API and console on the compose network:
- A staff member signed in with a password.
- An audit export was refused with the MFA message, the "confirm MFA" link set up a one-time code and came back, and the export then downloaded.
- A phone (a test client using a password grant) checked in, was signed out from `/app/devices`, and then its refresh token was refused by Keycloak (`invalid_grant`) and its access token by the API (`DEVICE_REVOKED`).

The images themselves were not built in that environment.

## HTTPS on the local network (test phones)

`infra/compose/lan-https.yaml` puts the local stack behind Caddy on port 443 of this machine, so a test phone on the same Wi-Fi can call the API, sign in at Keycloak and open the console over HTTPS. Still a test stack: Keycloak stays in `start-dev`, and anyone on the network can reach these three hosts.

1. In `.env`, set `EDGE_DOMAIN` to this machine's LAN address with dashes plus `.sslip.io`, e.g. `EDGE_DOMAIN=192-168-1-37.sslip.io` (sslip.io is public DNS that answers with the address written in the name). Give the machine a fixed address at the router, or the names change.
2. `docker compose -f compose.yaml -f lan-https.yaml up -d --build`. The hosts are `https://api.<EDGE_DOMAIN>`, `https://auth.<EDGE_DOMAIN>` (Keycloak, the issuer every client and the API use) and `https://console.<EDGE_DOMAIN>`.
3. Caddy signs the certificates with its own CA. On each test phone, open `https://api.<EDGE_DOMAIN>/staging-ca.crt` and install it: Android: Settings → Security → Install from device storage → CA certificate (opening the file from the browser is refused on Android 11+); iPhone: install the profile, then Settings → General → About → Certificate Trust Settings → full trust. Test phones only; remove it when testing ends. Android apps ignore user-installed CAs unless a debug build's `network_security_config` allows `<certificates src="user"/>` (never in a release build).
4. Inside the network, the API and console reach `auth.<EDGE_DOMAIN>` through Caddy (network aliases) and trust Caddy's root through `NODE_EXTRA_CA_CERTS`. Caddy keeps its CA in a root-only folder, so the one-shot `edge-ca` service copies only the public `root.crt` into the `edgeca` volume, readable by the `node` user the API and console run as. The console keeps its sessions in Postgres (`SESSION_DATABASE_URL`), which an https console requires.
5. A realm imported before this overlay keeps its old console URLs. Add the https ones once (`KEYCLOAK_ADMIN_PASSWORD` from `.env`):
   ```sh
   KC="docker compose exec keycloak /opt/keycloak/bin/kcadm.sh"
   $KC config credentials --server http://localhost:8080 --realm master --user admin --password "$KEYCLOAK_ADMIN_PASSWORD"
   ID=$($KC get clients -r tunedeck -q clientId=tunedeck-console --fields id --format csv --noquotes)
   $KC update clients/$ID -r tunedeck -s "redirectUris=[\"https://console.$EDGE_DOMAIN/auth/callback\",\"http://localhost:${CONSOLE_HOST_PORT:-3200}/auth/callback\"]" -s "attributes.\"post.logout.redirect.uris\"=https://console.$EDGE_DOMAIN/*##http://localhost:${CONSOLE_HOST_PORT:-3200}/*"
   ```
   Tokens issued before the switch name the old issuer and stop working; sign in again.
6. To keep a CA that phones already trust from an earlier Caddy, copy its `/data/caddy/pki` into the `caddydata` volume before the first start.

The mobile app's Keycloak client is still Codex's to define (client id, redirect URI); add it to the realm once known.

## Before staging or production

Do not reuse the local stack as is. In particular:
- Run Keycloak with `start` (not `start-dev`), on https with its own PostgreSQL database, and set `KC_HOSTNAME` to the public https URL.
- Import the realm with real values for the placeholders. Set the console's redirect to its public https URL.
- Configure SMTP for email verification and password reset, and decide whether `verifyEmail` should be on.
- API: `APP_ENV=staging` or `production`, `STAFF_MFA_ACR=mfa`, `CONFIG_SIGNING_KEY`, `KEYCLOAK_ADMIN_CLIENT_*`. Turn on `STATION_CHECK_ENABLED=true` once the network egress rules from Doc 17 are in place: run `npm run checker` (same image, same `DATABASE_URL` and `STATION_CHECK_*` keys) as its own service with outbound HTTPS on 443, set `STATION_CHECK_RUNNER=worker` on both, and give the API no outbound access to stream hosts. The API refuses to start without the first three. To offer the worldwide radio search, set `RADIO_BROWSER_BASE_URL` (one Radio Browser server, e.g. `https://de1.api.radio-browser.info`) and allow the API outbound HTTPS to that host only; leave it unset to keep the search off.
- Console: an https `CONSOLE_BASE_URL`, `SESSION_DATABASE_URL`, `OIDC_MFA_ACR=mfa`.
- The API and console must reach Keycloak at the same issuer URL the browsers use.
- Alerts: the API covers traffic, latency, the background queues (oldest due job over 5 minutes per queue, any dead letter) and late deletions (set `ALERT_WEBHOOK_URL` for chat messages). `backup.sh` records each checked dump in `backup_runs`, and the API raises `backup_stale` when the newest is 26 hours old (it needs `psql` next to `pg_dump`; a failed record is reported but does not fail the backup). The hosting platform has to cover what the API cannot see: database connection pool above 80% for 10 minutes, disk above 80%, and the provider's own backups if `backup.sh` is not used (Doc 17).

## Load test (`infra/load`)

The Doc 17 envelope (100 req/s + 20 diagnostic batches/s, p95 reads ≤ 300 ms, writes ≤ 500 ms) as a runnable tool, with a script for the throwaway test accounts it needs. Steps and the first local numbers are in `infra/load/README.md`. The 30-minute run on staging is still required before any capacity claim.

## Backup and restore (`infra/backup`)

Doc 17 targets: RPO 15 minutes, RTO 4 hours after an authorised restore, backups kept at most 35 days, and a restore drill before the first release and every quarter.

- **Point in time:** use the database provider's point-in-time recovery for the 15-minute RPO. These scripts do not provide it. Keycloak's database needs the same treatment.
- **Logical backup:** `DATABASE_URL=… ./backup.sh <dir>` writes `tunedeck-<UTC time>.dump` (custom format, mode 600). It fails if the dump has no table data. Run it nightly into private, encrypted storage that deletes files after 35 days.
- **Restore drill:** `ADMIN_DATABASE_URL=<scratch server>/postgres ./restore-drill.sh <dump>` restores into a throwaway database. It then reports the time taken, the latest migration, row counts for the main tables, that the audit table is still append-only, and how many accounts are waiting for deletion. Afterwards it drops the database. Keep each drill's output as evidence.
- **Real restore:** stop the API (the deletion and retention jobs run inside it), restore, run migrations, then start the API.
  - Accounts that were mid-deletion resume on their own.
  - Accounts whose deletion finished *after* the backup was taken come back with their data, while their Keycloak user is already gone. Before reopening, run the reconcile tool with the API's environment:
    - `docker compose run --rm api node dist/account/restore-reconcile-cli.js` (or `npm run restore-reconcile` in `services/api`) lists the accounts whose Keycloak user no longer exists, and changes nothing.
    - Add `--apply --by <you> --reason "<why>"` to queue them for deletion again. They are locked out and their devices signed out at once, each one is audited as `account.restore_repurge`, and the API's deletion queue finishes the purge.
    - If any Keycloak lookup fails, nothing changes. If more than 5% of accounts (and more than 3) look deleted, `--apply` stops unless you add `--allow-many`, because that usually means the database and Keycloak belong to different environments.
  - The reverse case is not covered: a Keycloak restored to an *older* point than the database still has users the app already deleted. Restore both from the same point in time.

Neither script prints connection strings. Both need `pg_dump`/`pg_restore` 16 or newer.
