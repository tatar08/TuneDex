# TuneDeck console (`apps/console`)

Next.js web app with a server-side BFF. This folder is COL-03 from [Doc 19](../../Docs/19-Claude-Codex-Collaboration.md): sign-in, session, sign-out and the user's own settings page. Admin screens (catalog, logs, themes) come later.

## How it works

- **Sign-in:** `/auth/login` starts OIDC authorization code + PKCE S256 with `state` and `nonce`, kept in a signed 10-minute HttpOnly cookie. `/auth/callback` checks state, exchanges the code as a confidential client (`client_secret_basic`), verifies the ID token (issuer, audience, signature, nonce) and starts a new session. After login it only redirects to `/app/...` or `/admin...` paths.
- **Session:** tokens stay on the server. The browser gets one opaque, HttpOnly, `SameSite=Lax` cookie (`__Host-td_session` with `Secure` outside localhost). Idle timeout 12 hours (Doc 17), absolute 7 days (proposal). Access tokens refresh automatically with rotation; a rejected refresh ends the session. Sessions live in PostgreSQL (`SESSION_DATABASE_URL`, table `console_sessions` created on first use) so any number of console instances share them and a restart signs nobody out; rows are keyed by a hash of the cookie and the tokens are encrypted with AES-256-GCM under a key derived from `SESSION_SECRET`. Outside localhost the database is required; on localhost without it sessions stay in memory.
- **CSRF:** every change (`PATCH /bff/settings`, `POST /auth/logout`) must come from the console's own `Origin` and carry the session's CSRF token.
- **Settings page** (`/app/settings`): theme, language and mobile-data policy as keyboard-friendly radio groups, Thai labels by default, English once the user saves `language = en`. Shows the saved revision. Below the form, each signed-in device shows "up to date" or "waiting for sync" by comparing the revision it last applied with the saved revision, plus app build and last-seen time in Thailand time (via `GET /bff/devices` and `GET /v1/me/devices`). If the device list fails to load, settings still work. On a 412 conflict the user can take the server's values or resend only the fields they changed, so changes made elsewhere to other fields are kept.
- **Logout:** deletes the server session, clears the cookie and sends the browser to the IdP's end-session endpoint when it has one.
- **Logs:** one JSON line per BFF request with method, route, status, duration and a request id that is also sent to the API. No tokens, cookies, codes or bodies.
- **Overview** (`/app/overview`): whether the service answers (the API readiness probe, with the time checked, or "cannot reach the service" with the rest marked possibly stale), the number of favorites and the settings revision, Pro per store (no checkout on the web), and each signed-in phone with its last successful sync and last check-in.
- **Radio** (`/app/radio`): the published catalog (name, country, language, genres, codec; never the stream address, which the BFF drops) and the account's favorites with move up/down and remove. Changes go through `POST /bff/sync/push` to the same sync API the phones use, naming the revisions shown, so a change made on a phone meanwhile comes back as a conflict and the page reloads the list. The page plays no audio.
- **Devices** (`/app/devices`): the account's phones (build, last seen) with "sign this device out". The API wants a sign-in from the last 5 minutes; when the session is older the page shows "confirm it is you", which runs `/auth/login?reauth=1` (OIDC `prompt=login`, `max_age=0`) and comes back with the same device still chosen. The callback refuses a re-authentication whose ID token `auth_time` is older than the request, so a provider quietly reusing its SSO session does not count. A `REAUTH_REQUIRED` answer never ends the web session.
- **Privacy** (`/app/privacy`): the account's own diagnostic reports from the phone app (what was sent, when it expires) with a delete button per report. Deleting needs the session's CSRF token. It also has "prepare my data": `POST /bff/account/exports` (CSRF and the same re-authentication as deletion, after which the page starts the export by itself), then the page polls `/bff/account/exports/{id}` and downloads through `/bff/account/exports/{id}/file`, which asks the API for a fresh 15-minute link and streams the file, so the API link never reaches the browser. It also has "let support see diagnostic reports": a one-time code to read out to support, the list of support members who currently have access, and a withdraw button (`/bff/support-access`). It also has "delete this account": a checkbox confirm, the same re-authentication as device sign-out, then the web session ends and the browser goes to `/account-deleted`, which follows progress with the ticket kept in the URL fragment (never sent to a server log).
- **Staff console** (`/admin/stations`): only for accounts with a staff role (granted with `npm run staff` in `services/api`); others see a plain refusal. Staff sessions use the Doc 17 limits (30 minutes idle, 12 hours absolute) from sign-in. Editors draft stations; a different admin publishes the exact reviewed revision with a reason, and can disable or re-enable a station. The API checks the role on every call, so hiding a button is never the control. API errors (bad stream URL, stale revision, publish blockers) are shown in Thai next to the field or action. Each theme's station list marks stream health for live stations, the Minimal dashboard has a "streams to look at" card, and the station page shows per-region results, the last 20 checks and a check-now button.
- **Overview** (`/admin/overview`, operators and admins, where `/admin` lands for them): API requests with 5xx stacked on the same scale (hover a bar for its numbers; a hidden table carries them for screen readers), 5xx rate with its sample size, p95/p50 latency, station health counts, the account-deletion queue and an incident list, for 1 hour, 24 hours or 7 days. A quiet system reads "no recent traffic", not healthy. Aggregates only.
- **Background jobs** (`/admin/jobs`, operators and admins): the account-deletion queue with age, attempts and the 30-day deadline, and a "retry now" button that needs a reason (recorded as `job.retry`). Failed deletions keep retrying in the background every 10 minutes regardless.
- **Support codes** (`/app/devices`): the customer sees their account code (`GET /v1/me`) and each device's code, with copy buttons, to read out to support.
- **Users** (`/admin/users`, support and admins, where `/admin` lands for support): look up one customer by the user id or device id they read out, with a recorded reason; shows account state, devices and whether each picked up the latest settings, diagnostics count and deletion state. No email, setting values or stations. With a one-time code the customer reads out (made on `/app/privacy`) and a reason, the support member can open that customer's diagnostic reports for 7 days; each theme places this in its own layout.
- **MFA before privileged actions:** station publish, config publish and rollback, and audit export need MFA from the last 5 minutes (the API's `MFA_REQUIRED`). The page then says so in Thai with "ยืนยัน MFA แล้วกลับมาหน้านี้", which runs `/auth/login?mfa=1` (a forced sign-in plus `acr_values` from `OIDC_MFA_ACR`) and returns to the same page; the action is then done again on purpose. Shared by all five themes.
- **Five themes, five layouts** (Tar, 2026-10-03): Minimal (default, top nav and rows), Control Room (dark sidebar and table), Broadcast Rack (top bar, live Bangkok clock, preset cards), Daylight Bento (rounded cards with search) and Workbench (icon rail, list pane beside the editor, `j`/`k`/`Enter` keys). Staff pick one from the header; the choice is a per-browser cookie scoped to `/admin`. Fonts are self-hosted by `next/font` at build time, so the build needs network access to Google Fonts once, but staff browsers never call Google.

## Run locally

```bash
cp .env.example .env.local   # point at Keycloak and services/api
npm ci
npm run build && npm start    # http://localhost:3200
```

Register `CONSOLE_BASE_URL/auth/callback` as the exact redirect URI and `CONSOLE_BASE_URL/login?signedOut=1` as the post-logout URI on the Keycloak client, and map the API audience onto its access tokens.

## Test

```bash
npm run typecheck
npm test                      # unit, component (jsdom) and BFF integration tests
npm run build && npm run test:e2e   # Chromium against next start
```

The integration and browser tests run the real `services/api` build against PostgreSQL (`TEST_DATABASE_URL`, default `postgres://postgres@127.0.0.1:54329/postgres`), so build it first: `cd ../../services/api && npm ci && npm run build`. Identity comes from a test-only OpenID provider in `test/mock-idp.ts`; nothing in `src/` can bypass sign-in.

## Not in this ticket

Ending the Keycloak session on device sign-out, CI. Sign-in and password-reset throttling is Keycloak's brute-force protection, not the console's.
