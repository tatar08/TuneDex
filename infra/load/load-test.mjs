#!/usr/bin/env node
// Doc 17 load envelope (T-BE): a steady arrival rate of API requests plus client diagnostic batches, measured
// at the client. Open loop: requests start on schedule whether or not earlier ones finished, so a slow server
// shows up as latency instead of quietly lowering the rate. No dependencies; Node 22+.
//
//   node load-test.mjs --api https://api.staging.example --issuer https://id.staging.example/realms/tunedeck \
//     --client tunedeck-loadtest --users users.txt [--rps 100] [--diag-rps 20] [--duration 30m] [--out result.json]
//
// users.txt holds one `username:password` per line (test accounts only, see seed-users.mjs). Each user signs in
// with a password grant and refreshes before its token expires. Tokens, passwords and response bodies are never
// printed. The API's per-user limits (120 reads, 30 writes, 10 diagnostic batches a minute) decide how many
// users are needed; the tool refuses to start with too few.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : acc), []),
);
const need = (k) => args[k] ?? (console.error(`missing --${k}`), process.exit(2));
const API = need('api').replace(/\/$/, '');
const ISSUER = need('issuer').replace(/\/$/, '');
const CLIENT = need('client');
const RPS = Number(args.rps ?? 100);
const DIAG_RPS = Number(args['diag-rps'] ?? 20);
const durationMs = parseDuration(args.duration ?? '30m');
const warmupMs = parseDuration(args.warmup ?? '30s');
const users = readFileSync(need('users'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  const i = l.indexOf(':');
  return { username: l.slice(0, i), password: l.slice(i + 1) };
});

/** Doc 17 targets at the server boundary; measured here at the client, so network time is included. */
const TARGETS = { readP95Ms: 300, writeP95Ms: 500, maxServerErrorRate: 0.001 };
/** Request mix: each user stays under 120 reads and 30 writes a minute at the computed user count. */
const MIX = [
  { name: 'GET /v1/me/settings', kind: 'read', weight: 35, run: (u) => call(u, 'GET', '/v1/me/settings') },
  { name: 'GET /v1/me/favorites', kind: 'read', weight: 20, run: (u) => call(u, 'GET', '/v1/me/favorites') },
  { name: 'GET /v1/sync/pull', kind: 'read', weight: 15, run: (u) => call(u, 'GET', '/v1/sync/pull') },
  { name: 'GET /v1/me/devices', kind: 'read', weight: 10, run: (u) => call(u, 'GET', '/v1/me/devices') },
  { name: 'GET /v1/me', kind: 'read', weight: 10, run: (u) => call(u, 'GET', '/v1/me') },
  { name: 'PUT /v1/me/devices/:id', kind: 'write', weight: 10, run: (u) => call(u, 'PUT', `/v1/me/devices/${u.deviceId}`, checkIn()) },
];
const totalWeight = MIX.reduce((s, m) => s + m.weight, 0);
const readShare = MIX.filter((m) => m.kind === 'read').reduce((s, m) => s + m.weight, 0) / totalWeight;
const writeShare = 1 - readShare;
// Stay at 80% of each per-user limit so the run measures the server, not the rate limiter.
const usersNeeded = Math.ceil(Math.max((RPS * readShare * 60) / 96, (RPS * writeShare * 60) / 24, (DIAG_RPS * 60) / 8));
if (users.length < usersNeeded) {
  console.error(`need at least ${usersNeeded} test users for ${RPS} req/s + ${DIAG_RPS} batches/s; users file has ${users.length}`);
  process.exit(2);
}

const stats = new Map();
const record = (name, kind, ms, status) => {
  let s = stats.get(name);
  if (!s) stats.set(name, (s = { kind, lat: [], statuses: {} }));
  s.lat.push(ms);
  s.statuses[status] = (s.statuses[status] ?? 0) + 1;
};
let measuring = false;
let inFlight = 0;
let dropped = 0;
const MAX_IN_FLIGHT = Number(args['max-in-flight'] ?? 2000);

async function token(u) {
  if (u.token && u.expiresAt > Date.now() + 30_000) return u.token;
  const body = u.refresh
    ? new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: u.refresh })
    : new URLSearchParams({ grant_type: 'password', client_id: CLIENT, username: u.username, password: u.password, scope: 'openid' });
  let res = await fetch(`${ISSUER}/protocol/openid-connect/token`, { method: 'POST', body });
  if (!res.ok && u.refresh) {
    u.refresh = null;
    return token(u);
  }
  if (!res.ok) throw new Error(`sign-in failed for a test user (${res.status})`);
  const t = await res.json();
  Object.assign(u, { token: t.access_token, refresh: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000 });
  return u.token;
}

async function call(u, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${await token(u)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  await res.arrayBuffer();
  return res.status;
}

const checkIn = () => ({ platform: 'android', osMajor: 15, appBuild: '1.0.0+42', appliedSettingsRevision: 0 });
const batch = (u) => ({
  batchId: randomUUID(),
  deviceId: u.deviceId,
  consent: true,
  events: Array.from({ length: 20 }, (_, i) => ({
    eventId: randomUUID(),
    eventName: 'playback_start_result',
    schemaVersion: 1,
    monotonicMs: Date.now() + i,
    sessionRandomId: u.session,
    durationMs: 800 + i,
    resultCode: 'OK',
    networkClass: 'cellular',
    appBuild: '1.0.0+42',
    osMajor: 15,
    deviceClass: 'phone',
  })),
});

function fire(name, kind, fn) {
  if (inFlight >= MAX_IN_FLIGHT) {
    if (measuring) dropped++;
    return;
  }
  inFlight++;
  const start = performance.now();
  fn()
    .then((status) => measuring && record(name, kind, performance.now() - start, status))
    .catch((err) => measuring && record(name, kind, performance.now() - start, err?.name === 'TimeoutError' ? 'timeout' : 'network'))
    .finally(() => inFlight--);
}

/** Starts `perSecond` arrivals a second, evenly spaced, until `endAt`. */
function schedule(perSecond, endAt, each) {
  if (perSecond <= 0) return Promise.resolve();
  const gap = 1000 / perSecond;
  let next = performance.now();
  return new Promise((resolve) => {
    const tick = () => {
      const now = performance.now();
      while (next <= now) {
        each();
        next += gap;
      }
      if (Date.now() >= endAt) return resolve();
      setTimeout(tick, Math.max(0, Math.min(gap, next - performance.now())));
    };
    tick();
  });
}

function parseDuration(s) {
  const m = /^(\d+)(ms|s|m|h)$/.exec(String(s));
  if (!m) throw new Error(`bad duration ${s}`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);

async function main() {
  const pool = users.slice(0, usersNeeded).map((u) => ({ ...u, deviceId: randomUUID(), session: randomUUID().replaceAll('-', '') }));
  console.log(`signing in ${pool.length} test users and registering one device each…`);
  for (let i = 0; i < pool.length; i += 20) {
    await Promise.all(
      pool.slice(i, i + 20).map(async (u) => {
        const status = await call(u, 'PUT', `/v1/me/devices/${u.deviceId}`, checkIn());
        if (status !== 200) throw new Error(`device check-in failed for a test user (${status})`);
      }),
    );
  }
  let r = 0;
  let d = 0;
  const pick = () => {
    let x = Math.random() * totalWeight;
    return MIX.find((m) => (x -= m.weight) < 0) ?? MIX[0];
  };
  const runFor = async (ms) => {
    const endAt = Date.now() + ms;
    await Promise.all([
      schedule(RPS, endAt, () => {
        const m = pick();
        const u = pool[r++ % pool.length];
        fire(m.name, m.kind, () => m.run(u));
      }),
      schedule(DIAG_RPS, endAt, () => {
        const u = pool[d++ % pool.length];
        fire('POST /v1/diagnostics/batches', 'write', () => call(u, 'POST', '/v1/diagnostics/batches', batch(u)));
      }),
    ]);
  };
  console.log(`warming up for ${warmupMs / 1000} s…`);
  await runFor(warmupMs);
  console.log(`measuring ${RPS} req/s + ${DIAG_RPS} diagnostic batches/s for ${durationMs / 1000} s…`);
  measuring = true;
  const t0 = Date.now();
  await runFor(durationMs);
  const elapsed = (Date.now() - t0) / 1000;
  while (inFlight > 0) await new Promise((res) => setTimeout(res, 100));
  measuring = false;

  const rows = [];
  let total = 0;
  let server = 0;
  let failures = 0;
  const byKind = { read: [], write: [] };
  for (const [name, s] of stats) {
    s.lat.sort((a, b) => a - b);
    const n = s.lat.length;
    const s5 = Object.entries(s.statuses).filter(([k]) => k === 'timeout' || k === 'network' || Number(k) >= 500).reduce((a, [, v]) => a + v, 0);
    const other = Object.entries(s.statuses).filter(([k]) => Number(k) >= 400 && Number(k) < 500).reduce((a, [, v]) => a + v, 0);
    total += n;
    server += s5;
    failures += other;
    byKind[s.kind].push(...s.lat);
    rows.push({ name, kind: s.kind, n, perSecond: +(n / elapsed).toFixed(1), p50: Math.round(pct(s.lat, 50)), p95: Math.round(pct(s.lat, 95)), p99: Math.round(pct(s.lat, 99)), max: Math.round(s.lat[n - 1]), statuses: s.statuses });
  }
  for (const k of Object.keys(byKind)) byKind[k].sort((a, b) => a - b);
  const summary = {
    at: new Date().toISOString(),
    target: { api: API, rps: RPS, diagRps: DIAG_RPS, durationSeconds: durationMs / 1000, users: pool.length },
    achieved: { requests: total, perSecond: +(total / elapsed).toFixed(1), droppedAtClient: dropped },
    readP95Ms: Math.round(pct(byKind.read, 95) ?? 0),
    writeP95Ms: Math.round(pct(byKind.write, 95) ?? 0),
    serverErrorRate: total ? server / total : null,
    clientErrors: failures,
    endpoints: rows,
  };
  const checks = {
    'reads p95 ≤ 300 ms': summary.readP95Ms <= TARGETS.readP95Ms,
    'writes p95 ≤ 500 ms': summary.writeP95Ms <= TARGETS.writeP95Ms,
    '5xx/timeouts ≤ 0.1%': summary.serverErrorRate !== null && summary.serverErrorRate <= TARGETS.maxServerErrorRate,
    'no 4xx (limits or bad requests)': failures === 0,
    'rate held (≥ 95% of target, none dropped)': dropped === 0 && total / elapsed >= 0.95 * (RPS + DIAG_RPS),
  };
  summary.checks = checks;
  console.table(rows.map(({ statuses, ...r }) => ({ ...r, statuses: JSON.stringify(statuses) })));
  for (const [k, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${k}`);
  console.log(`reads p95 ${summary.readP95Ms} ms · writes p95 ${summary.writeP95Ms} ms · ${summary.achieved.perSecond} req/s achieved`);
  if (args.out) writeFileSync(args.out, JSON.stringify(summary, null, 2));
  process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
}

main().catch((err) => {
  console.error(`load test stopped: ${err.message}`);
  process.exitCode = 2;
});
