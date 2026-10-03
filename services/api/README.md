# TuneDeck API (`services/api`)

NestJS + PostgreSQL backend. This folder started as COL-01 from [Doc 19](../../Docs/19-Claude-Codex-Collaboration.md) and now holds health probes, account settings, the device registry, staff roles and the radio station catalog. It is self-contained (own `package.json` and lockfile) so it does not touch root manifests that COL-00 will define.

## What it does

| Route | Behavior |
|---|---|
| `GET /health/live` | 200 while the process runs |
| `GET /health/ready` | 200 when PostgreSQL answers, else 503 |
| `GET /v1/me/settings` | The signed-in account's settings with `ETag: "<revision>"`. New accounts get defaults at revision 0 |
| `PATCH /v1/me/settings` | Partial update. Requires `If-Match: "<revision>"`; stale → 412 `REVISION_MISMATCH` with `currentRevision` |
| `GET /v1/me/devices` | The account's devices plus the current `settingsRevision`, active first, most recently seen first |
| `PUT /v1/me/devices/{deviceId}` | The phone app's check-in: registers the device on first call, then records platform, OS major, app build and the settings revision it has applied |
| `DELETE /v1/me/devices/{deviceId}/session` | Revokes a device. Needs a sign-in within the last 5 minutes (`auth_time`), else 401 `REAUTH_REQUIRED` |
| `GET /v1/me/staff` | The caller's current staff roles (empty for customers), so the console knows which pages to show |
| `GET /v1/catalog/radio?cursor=&limit=` | Public, no sign-in. Published, enabled stations with current rights; opaque cursor, `limit` ≤100, weak ETag and `If-None-Match` → 304, `Cache-Control: public, max-age=300` |
| `GET /v1/admin/stations`, `GET /v1/admin/stations/{id}` | `catalog_editor` or `admin`. Draft, published snapshot, status and the reasons the caller could not publish right now |
| `POST /v1/admin/stations`, `PATCH /v1/admin/stations/{id}` | `catalog_editor` or `admin`. Edits the draft only; PATCH needs `If-Match` |
| `POST /v1/admin/stations/{id}/publish` | `admin`, with `If-Match` naming the reviewed revision and a `reason` |
| `POST /v1/admin/stations/{id}/disable`, `/enable` | `admin`, with a `reason`. Hides or restores the station in the public catalog at once |

- **Auth:** every `/v1` call except the public catalog needs an OIDC bearer token verified against the JWKS for issuer, audience, expiry and an asymmetric algorithm. The account comes from the token `sub`, never from the body or URL. Unknown key or bad token → 401; key set unreachable → 503 (fails closed). Accounts in `deleting`/`disabled` status → 403. There is no dev bypass; fake identity exists only in `test/`.
- **Settings allowlist** (proposal, see `openapi.proposal.yaml`): `theme` system/light/dark, `language` th/en, `cellularPolicy` allow/wifi_only. Defaults: system, th, allow.
- **Devices:** `deviceId` is a UUID the app generates once per install. Check-ins accept only `platform` (ios/android), `osMajor`, `appBuild` and `appliedSettingsRevision`; no device name, model or advertising id is stored. An applied revision higher than the server's → 400; a late, older report never moves the applied revision backwards. A revoked device's check-in → 403 `DEVICE_REVOKED` (the app should sign out). At most 20 active devices per account → 409 `DEVICE_LIMIT`. Device ids are scoped per account, so another account's id is simply not found.
- **Staff roles** (`support`, `catalog_editor`, `operator`, `admin`, `auditor`) live in the database and are read on every staff request, so a revoke takes effect on the next call. There is no self-service grant: an operator runs `DATABASE_URL=… npm run staff -- grant <oidc-subject> <role> --by <name> --reason "<why>"` (also `revoke`, `list`). Each grant and revoke is audited.
- **Station catalog:** every station has a draft and, once approved, a published snapshot; only the snapshot reaches the apps. Two-person rule: anyone who changed the draft since its last publish cannot publish it. Publishing also needs a rights basis and reference, and an expiry date that has not passed; once the expiry date passes the station drops out of the public catalog on its own. Stream URLs must be `https://` on port 443 with a public host name (no IP literals, `localhost` or internal suffixes, no credentials). The API never fetches them; health checks belong to the future worker.
- **Audit:** station creates, edits, publishes, disables, enables and role changes write `audit_events` in the same transaction as the change, so if the audit write fails the change rolls back. The table rejects UPDATE and DELETE.
- **Errors** use `{code, messageKey, requestId, details}` with no tokens or PII. Bodies over 16 KiB → 413.
- **Logs:** one JSON line per request (timestamp, severity, service, environment, build, eventCode, requestId, method, route template, status, durationMs, internal account id). Headers, bodies and query strings are never logged. A well-formed inbound `X-Request-Id` is reused, otherwise one is generated.

## Run locally

```bash
cp .env.example .env    # fill in DATABASE_URL and your Keycloak realm
npm ci
npm run build
npm run migrate         # forward-only SQL migrations in src/db/migrations
npm start               # listens on PORT (default 3100)
```

Environment keys (no secrets committed): `APP_ENV`, `BUILD_VERSION`, `PORT`, `DATABASE_URL`, `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URI`, `OIDC_ALGORITHMS`.

## Test

Tests run against a real PostgreSQL. Each test file creates and drops its own database.

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npm test
npm run typecheck
```

## Migrations

`001_users_and_account_preferences.sql` creates `users` (OIDC subject, status, no password) and `account_preferences` (owner, schema version, revision, JSON value). `002_devices.sql` creates `devices` keyed by (owner, device id). `003_staff_stations_audit.sql` creates `staff_roles`, `radio_stations` and the append-only `audit_events`. Migrations are forward-only and serialized with an advisory lock; to undo, add a new migration.

## Not in this slice

Rate limits, CSRF/BFF (COL-03), per-device preference overrides, invalidating a revoked device's refresh token at the IdP (needs the Keycloak admin API), recent-MFA checks and staff session limits for privileged actions, the admin console pages, station health checks and multiple stream variants per station, audit outbox, metrics/traces, Dockerfile and CI. Shared OpenAPI, root scripts and CI belong to COL-00.
