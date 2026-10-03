# TuneDeck API (`services/api`)

NestJS + PostgreSQL backend. This folder is COL-01 from [Doc 19](../../Docs/19-Claude-Codex-Collaboration.md): health probes and the account settings slice. It is self-contained (own `package.json` and lockfile) so it does not touch root manifests that COL-00 will define.

## What it does

| Route | Behavior |
|---|---|
| `GET /health/live` | 200 while the process runs |
| `GET /health/ready` | 200 when PostgreSQL answers, else 503 |
| `GET /v1/me/settings` | The signed-in account's settings with `ETag: "<revision>"`. New accounts get defaults at revision 0 |
| `PATCH /v1/me/settings` | Partial update. Requires `If-Match: "<revision>"`; stale → 412 `REVISION_MISMATCH` with `currentRevision` |

- **Auth:** every `/v1` call needs an OIDC bearer token verified against the JWKS for issuer, audience, expiry and an asymmetric algorithm. The account comes from the token `sub`, never from the body or URL. Unknown key or bad token → 401; key set unreachable → 503 (fails closed). Accounts in `deleting`/`disabled` status → 403. There is no dev bypass; fake identity exists only in `test/`.
- **Settings allowlist** (proposal, see `openapi.proposal.yaml`): `theme` system/light/dark, `language` th/en, `cellularPolicy` allow/wifi_only. Defaults: system, th, allow.
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

`001_users_and_account_preferences.sql` creates `users` (OIDC subject, status, no password) and `account_preferences` (owner, schema version, revision, JSON value). Migrations are forward-only and serialized with an advisory lock; to undo, add a new migration.

## Not in this slice

Rate limits, CSRF/BFF (COL-03), device preferences, audit outbox, metrics/traces, Dockerfile and CI. Shared OpenAPI, root scripts and CI belong to COL-00.
