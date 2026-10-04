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

- Console: http://localhost:3200. Keycloak: http://keycloak.localhost:8080 (admin console under `/admin`, user `admin`, password from `.env`). API: http://localhost:3100.
- Browsers send `*.localhost` to this machine, and inside the compose network the same name points at the Keycloak container, so the browser, the API and the console all see one issuer. Chrome, Edge and Firefox do this without setup. If a browser cannot open `keycloak.localhost`, add `127.0.0.1 keycloak.localhost` to the hosts file.
- The realm (`keycloak/tunedeck-realm.json`) is imported on the first start only. To start over, run `docker compose down -v`. It contains:
  - The `tunedeck-console` confidential client (PKCE S256, its redirect and logout URLs come from `.env`) with the `tunedeck-api` audience on access tokens.
  - The `tunedeck-api-admin` service account with `realm-management` / `manage-users`. The API uses it to delete Keycloak users on account deletion and to end a signed-out phone's session.
  - The browser flow `browser with mfa step-up`:
    - Level 1 (`acr` = `password`) asks for the password.
    - Level 2 (`acr` = `mfa`) also asks for a one-time code (TOTP). A staff member without one sets it up on that screen.
    - The API's `STAFF_MFA_ACR` and the console's `OIDC_MFA_ACR` are both `mfa`.
  - A user profile with only username and email (no name fields), registration by email, a 12-character minimum password, and brute-force protection.
  - The mobile app's client is not in this file: its redirect URI and client type are Codex's to decide.
- Staff roles: sign in once, then `docker compose exec api node dist/staff/staff-cli.js grant <subject> admin --by <you> --reason "<why>"`. The subject is the Keycloak user id.
- Postgres listens on 127.0.0.1:5432 (user `tunedeck`, password from `.env`). Console sessions live in memory here because the base URL is localhost.

Checked on 2026-10-04 against Keycloak 26.4, with the API and console on the compose network:
- A staff member signed in with a password.
- An audit export was refused with the MFA message, the "confirm MFA" link set up a one-time code and came back, and the export then downloaded.
- A phone (a test client using a password grant) checked in, was signed out from `/app/devices`, and then its refresh token was refused by Keycloak (`invalid_grant`) and its access token by the API (`DEVICE_REVOKED`).

The images themselves were not built in that environment.

## Before staging or production

Do not reuse the local stack as is. In particular:
- Run Keycloak with `start` (not `start-dev`), on https with its own PostgreSQL database, and set `KC_HOSTNAME` to the public https URL.
- Import the realm with real values for the placeholders. Set the console's redirect to its public https URL.
- Configure SMTP for email verification and password reset, and decide whether `verifyEmail` should be on.
- API: `APP_ENV=staging` or `production`, `STAFF_MFA_ACR=mfa`, `CONFIG_SIGNING_KEY`, `KEYCLOAK_ADMIN_CLIENT_*`. Turn on `STATION_CHECK_ENABLED=true` once the network egress rules from Doc 17 are in place. The API refuses to start without the first three.
- Console: an https `CONSOLE_BASE_URL`, `SESSION_DATABASE_URL`, `OIDC_MFA_ACR=mfa`.
- The API and console must reach Keycloak at the same issuer URL the browsers use.
- Alerts: the API covers traffic, latency and the deletion queue (set `ALERT_WEBHOOK_URL` for chat messages). The hosting platform has to cover what the API cannot see: database connection pool above 80% for 10 minutes, disk above 80%, and no successful backup for 24 hours (Doc 17).

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
