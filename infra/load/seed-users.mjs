#!/usr/bin/env node
// Creates (or removes) the throwaway accounts and the password-grant client the load test signs in with.
// Staging or local only: these accounts can sign in with a password alone, so never run this against production.
//
//   KEYCLOAK_ADMIN_USER=admin KEYCLOAK_ADMIN_PASSWORD=… node seed-users.mjs --keycloak https://id.staging.example \
//     --realm tunedeck --env staging --count 150 --out users.txt
//   … node seed-users.mjs --keycloak … --realm tunedeck --env staging --remove
//
// The admin credentials come from the environment and are never printed. users.txt is written with mode 600.
// API accounts the test created stay in the API database as ordinary accounts; after --remove,
// `npm run restore-reconcile -- --apply` in services/api deletes them (their Keycloak users are gone).
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : acc), []),
);
const need = (k) => args[k] ?? (console.error(`missing --${k}`), process.exit(2));
const BASE = need('keycloak').replace(/\/$/, '');
const REALM = need('realm');
if (!['staging', 'local'].includes(args.env)) {
  console.error('--env staging|local is required: this tool must never run against production');
  process.exit(2);
}
const CLIENT = 'tunedeck-loadtest';
const PREFIX = 'loadtest-';
const ADMIN = `${BASE}/admin/realms/${REALM}`;

const adminToken = async () => {
  const res = await fetch(`${BASE}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: process.env.KEYCLOAK_ADMIN_USER ?? '', password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? '' }),
  });
  if (!res.ok) throw new Error(`admin sign-in failed (${res.status}); set KEYCLOAK_ADMIN_USER and KEYCLOAK_ADMIN_PASSWORD`);
  return (await res.json()).access_token;
};

async function main() {
  const H = { authorization: `Bearer ${await adminToken()}`, 'content-type': 'application/json' };
  const [existing] = await (await fetch(`${ADMIN}/clients?clientId=${CLIENT}`, { headers: H })).json();
  if (args.remove === 'true') {
    let removed = 0;
    for (;;) {
      const batch = await (await fetch(`${ADMIN}/users?search=${PREFIX}&max=100`, { headers: H })).json();
      const mine = batch.filter((u) => u.username.startsWith(PREFIX));
      if (mine.length === 0) break;
      for (const u of mine) if ((await fetch(`${ADMIN}/users/${u.id}`, { method: 'DELETE', headers: H })).ok) removed++;
    }
    if (existing) await fetch(`${ADMIN}/clients/${existing.id}`, { method: 'DELETE', headers: H });
    console.log(`removed ${removed} test users${existing ? ` and the ${CLIENT} client` : ''}`);
    return;
  }
  if (!existing) {
    const res = await fetch(`${ADMIN}/clients`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        clientId: CLIENT,
        name: 'Load test only (delete after the run)',
        publicClient: true,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: true,
        protocolMappers: [{ name: 'tunedeck-api audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper', config: { 'included.custom.audience': 'tunedeck-api', 'access.token.claim': 'true' } }],
      }),
    });
    if (res.status !== 201) throw new Error(`creating the ${CLIENT} client failed (${res.status})`);
  }
  const count = Number(args.count ?? 150);
  const lines = [];
  for (let i = 1; i <= count; i++) {
    const username = `${PREFIX}${String(i).padStart(4, '0')}@tunedeck.test`;
    const password = randomBytes(18).toString('base64url');
    let res = await fetch(`${ADMIN}/users`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ username, email: username, emailVerified: true, enabled: true, credentials: [{ type: 'password', value: password, temporary: false }] }),
    });
    if (res.status === 409) {
      const [u] = await (await fetch(`${ADMIN}/users?username=${encodeURIComponent(username)}&exact=true`, { headers: H })).json();
      res = await fetch(`${ADMIN}/users/${u.id}/reset-password`, { method: 'PUT', headers: H, body: JSON.stringify({ type: 'password', value: password, temporary: false }) });
    }
    if (!res.ok) throw new Error(`creating test user ${i} failed (${res.status})`);
    lines.push(`${username}:${password}`);
  }
  writeFileSync(need('out'), lines.join('\n') + '\n', { mode: 0o600 });
  console.log(`${count} test users ready in ${args.out}; client ${CLIENT} (password grant). Remove both after the run with --remove.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
