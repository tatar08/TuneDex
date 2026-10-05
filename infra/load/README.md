# Load test (Doc 17 T-BE envelope)

Doc 17 asks for 100 API requests a second plus 20 client diagnostic batches a second for 30 minutes on the declared staging size, with reads at p95 ≤ 300 ms and writes at p95 ≤ 500 ms, before any capacity claim.

`load-test.mjs` drives exactly that, and needs only Node 22.
- **Open loop:** requests start on schedule whether or not earlier ones have finished, so a slow server shows up as latency instead of a lower rate.
- **Request mix:** settings, favorites, sync pull, devices, `/v1/me` and device check-ins, plus diagnostic batches of 20 events.
- **Users:** each test user stays under 80% of the API's per-user limits (120 reads, 30 writes and 10 diagnostic batches a minute). The tool works out how many users that takes (150 at the default rate) and refuses to start with fewer.
- **Results:** it prints per-endpoint p50/p95/p99, statuses and the achieved rate, plus a PASS/FAIL line for each target. With `--out` it writes the same as JSON. The exit code is non-zero if any check fails.
- **No secrets in output:** tokens, passwords and response bodies are never printed.
- **Public catalog not included:** it is limited to 60 a minute per IP at the gateway, so it needs its own test from several addresses.

## Running against staging

```sh
cd infra/load
# 1. Throwaway accounts and a password-grant client (staging or local only; the tool refuses without --env).
KEYCLOAK_ADMIN_USER=… KEYCLOAK_ADMIN_PASSWORD=… node seed-users.mjs \
  --keycloak https://<keycloak> --realm tunedeck --env staging --count 160 --out users.txt
# 2. The run (30 minutes measured after a 30 s warm-up).
node load-test.mjs --api https://<api> --issuer https://<keycloak>/realms/tunedeck \
  --client tunedeck-loadtest --users users.txt --duration 30m --out result.json
# 3. Clean up: remove the Keycloak users and client, then delete their API accounts.
KEYCLOAK_ADMIN_USER=… KEYCLOAK_ADMIN_PASSWORD=… node seed-users.mjs --keycloak https://<keycloak> --realm tunedeck --env staging --remove
# (in the API container) all of them look deleted, so --allow-many is needed here:
node dist/account/restore-reconcile-cli.js --apply --by <you> --reason "remove load test accounts" --allow-many
rm users.txt
```

Run the load generator from a separate machine in the same region, not from the API host. Keep `result.json` as evidence together with the staging size: CPU, memory, database tier and number of API instances.

## Local run, 2026-10-04 (not a capacity claim)

The API, PostgreSQL 16, Keycloak 26.4 and the load generator all ran on one 4-CPU, 15 GB container, over plain http with rate limits on. The client and the server shared the same CPUs, and there was no network between them.

| Run | Achieved | Reads p95 | Writes p95 | 5xx / 4xx |
|---|---|---|---|---|
| Doc 17 envelope: 100 req/s + 20 batches/s, 3 min | 120 req/s, 21,603 requests | 4 ms | 8 ms | 0 / 0 |
| 5× requests: 500 req/s + 20 batches/s, 1 min | 520 req/s | 4 ms | 9 ms | 0 / 0 |

At 520 req/s the API process used about 30% of one CPU and 180 MB of memory. The numbers show the code path is cheap. They say nothing yet about staging, where TLS, the network, a managed database and the real Keycloak add latency. The 30-minute staging run is still required.

The cleanup path was also checked locally. `seed-users.mjs --remove` removed the 300 users and the client. `restore-reconcile` then refused at first (282 of 282 accounts looked deleted). With `--allow-many` it queued them for deletion.
