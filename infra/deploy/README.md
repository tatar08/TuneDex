# One-server deployment (`infra/deploy`)

The TuneDeck backend on one Linux server with a real domain, for the staging that Doc 17 asks for (the 30-minute load test, real phones from anywhere, store sandbox purchases) and for an early production. It is the local stack (`../compose`) with the gaps listed under "Before staging or production" in `../README.md` closed:

| | Local (`../compose`) | This |
|---|---|---|
| HTTPS | none, or Caddy's own CA on the LAN | Let's Encrypt for `api.`, `auth.`, `console.<DOMAIN>` |
| Keycloak | `start-dev`, H2 inside its volume | `start`, its own Postgres database `keycloak` (included in backups) |
| Keycloak admin console and admin API | open | answer 404 from the internet (the API reaches them inside the Docker network); use `kcadm` on the server |
| API | `APP_ENV=dev` | `staging`/`production`: signing key, MFA and the Keycloak admin client are required at start |
| Stream checks | in the API | `checker` service only (`--profile checker`), `STATION_CHECK_RUNNER=worker` |
| Published ports | 127.0.0.1 only | 80 and 443; Postgres on 127.0.0.1 for psql |
| Backups | run `backup.sh` by hand | `backup` service, both databases, 35-day retention |

## Steps

1. **Server.** Any Linux host with Docker Compose v2, 2 vCPU / 4 GB RAM is enough for staging (Keycloak alone peaked at 1.8 GiB in the local load test). Open ports 80 and 443 only.
2. **DNS.** Point `api.<DOMAIN>`, `auth.<DOMAIN>` and `console.<DOMAIN>` at the server (A and, if it has IPv6, AAAA).
3. **Secrets.** `cp .env.example .env` and fill every value. `CONFIG_SIGNING_KEY` comes from `npm run config-key` in `services/api`; give the printed public key to the app build for this environment. Staging and production use different keys.
4. **Start.** `docker compose up -d --build`. The first start imports the realm from `../compose/keycloak/tunedeck-realm.json` (console client, mobile client `tunedeck-mobile`, MFA flow, login theme) and runs the API migrations.
5. **Check from outside.** From any other machine: `./smoke.sh <DOMAIN>`. It checks certificates, the API's health and signed config, the Keycloak issuer, that Keycloak's admin paths answer 404, the console sign-in page, the http→https redirect and HSTS. It needs no secrets. If the admin checks fail, Caddy is seeing a private source address for outside traffic (Docker's userland proxy does this, e.g. for IPv6 without `ip6tables`). Fix the host networking before going further: the admin pages still need the Keycloak admin password, but they should not be reachable at all.
6. **First staff member.** Create the account by signing up at `https://console.<DOMAIN>`, enroll the one-time code, then on the server: `docker compose exec api npm run staff -- grant <oidc-subject> admin --by <name> --reason "<why>"` (the subject is the Keycloak user id; see the `services/api` README). Roles are never granted from the web.
7. **Email.** Keycloak needs SMTP for email verification and password reset: `kcadm.sh update realms/tunedeck -s 'smtpServer={"host":"…","port":"587","starttls":"true","auth":"true","user":"…","password":"…","from":"no-reply@<DOMAIN>"}'`, then decide whether `verifyEmail` is on.
8. **Backups.** The `backup` service dumps both databases when it starts and then every `BACKUP_INTERVAL_HOURS` (24) into the `backups` volume. Each dump is checked for table data, and the TuneDeck dump is recorded in `backup_runs`, so the API raises `backup_stale` when none is newer than 26 hours. Dumps older than `BACKUP_KEEP_DAYS` (35) are deleted. **Copy them off the server** on a schedule, e.g. a host cron with `docker compose cp backup:/backups /srv/offsite-staging` followed by your storage tool. A dump that stays on the same disk does not survive losing the server. Run the restore drill once before the first release: `docker compose exec backup /opt/tunedeck-backup/restore-drill.sh /backups/<tunedeck-….dump>` with `ADMIN_DATABASE_URL` set to a scratch Postgres server, never this one's production database.
9. **Stream checks (optional).** `STATION_CHECK_ENABLED=true` and `docker compose --profile checker up -d`. Doc 17 wants only the checker to reach stream hosts; on one server that needs a host firewall rule (or a second server for the checker), which this file does not set up.

## What this does not cover

- Point-in-time recovery (RPO 15 minutes): the `backup` service gives an RPO of its interval (24 hours by default). Use a managed Postgres with PITR, or WAL archiving, before production.
- More than one server, zero-downtime deploys, and host hardening (SSH, updates, firewall).
- Store keys (Apple/Google) for Pro purchases: add the variables from the `services/api` README when the store accounts exist.
