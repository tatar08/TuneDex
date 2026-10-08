# One-server deployment (`infra/deploy`)

The TuneDeck backend on one Linux server with a real domain, for the staging that Doc 17 asks for (the 30-minute load test, real phones from anywhere, store sandbox purchases) and for an early production. It is the local stack (`../compose`) with the gaps listed under "Before staging or production" in `../README.md` closed:

| | Local (`../compose`) | This |
|---|---|---|
| HTTPS | none, or Caddy's own CA on the LAN | Let's Encrypt for `api.`, `auth.`, `console.<DOMAIN>` |
| Keycloak | `start-dev`, H2 inside its volume | `start`, its own Postgres database `keycloak` (included in backups) |
| Keycloak admin console and admin API | open | answer 404 from the internet (the API reaches them inside the Docker network); use `kcadm` on the server |
| API | `APP_ENV=dev` | `staging`/`production`: signing key, MFA and the Keycloak admin client are required at start |
| Stream checks | in the API | `checker` service only (`--profile checker`), `STATION_CHECK_RUNNER=worker` |
| Published ports | 127.0.0.1 only | 80 and 443; Postgres on 127.0.0.1 for backups |

## Steps

1. **Server.** Any Linux host with Docker Compose v2, 2 vCPU / 4 GB RAM is enough for staging (Keycloak alone peaked at 1.8 GiB in the local load test). Open ports 80 and 443 only.
2. **DNS.** Point `api.<DOMAIN>`, `auth.<DOMAIN>` and `console.<DOMAIN>` at the server (A and, if it has IPv6, AAAA).
3. **Secrets.** `cp .env.example .env` and fill every value. `CONFIG_SIGNING_KEY` comes from `npm run config-key` in `services/api`; give the printed public key to the app build for this environment. Staging and production use different keys.
4. **Start.** `docker compose up -d --build`. The first start imports the realm from `../compose/keycloak/tunedeck-realm.json` (console client, mobile client `tunedeck-mobile`, MFA flow, login theme) and runs the API migrations.
5. **First staff member.** Create the account by signing up at `https://console.<DOMAIN>`, enroll the one-time code, then on the server: `docker compose exec api npm run staff -- grant <oidc-subject> admin --by <name> --reason "<why>"` (the subject is the Keycloak user id; see the `services/api` README). Roles are never granted from the web.
6. **Email.** Keycloak needs SMTP for email verification and password reset: `kcadm.sh update realms/tunedeck -s 'smtpServer={"host":"…","port":"587","starttls":"true","auth":"true","user":"…","password":"…","from":"no-reply@<DOMAIN>"}'`, then decide whether `verifyEmail` is on.
7. **Backups.** On the server, a cron entry that runs `../backup/backup.sh` with `DATABASE_URL=postgres://tunedeck:…@127.0.0.1:5432/tunedeck` (needs `postgresql-client` 16 and `python3`), and the same for the `keycloak` database with its own user. Copy the dumps off the server. The API raises `backup_stale` when the newest recorded backup is 26 hours old. Run `../backup/restore-drill.sh` once before the first release.
8. **Stream checks (optional).** `STATION_CHECK_ENABLED=true` and `docker compose --profile checker up -d`. Doc 17 wants only the checker to reach stream hosts; on one server that needs a host firewall rule (or a second server for the checker), which this file does not set up.

## What this does not cover

- Point-in-time recovery (RPO 15 minutes): nightly dumps alone give RPO 24 hours. Use a managed Postgres with PITR, or WAL archiving, before production.
- More than one server, zero-downtime deploys, and host hardening (SSH, updates, firewall).
- Store keys (Apple/Google) for Pro purchases: add the variables from the `services/api` README when the store accounts exist.
