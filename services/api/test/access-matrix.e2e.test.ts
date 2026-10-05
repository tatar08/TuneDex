import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { Database } from '../src/db/database';
import { runStaffCli } from '../src/staff/staff-cli';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';
import { servedRoutes } from './routes';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml: { load: (text: string) => unknown } = require('js-yaml');

/**
 * Doc 17 T-RBAC and the Doc 10 IDOR gate, over every route the API serves rather than one module at a time:
 * no token is 401 everywhere but the public routes; each staff route answers ROLE_REQUIRED to every role it
 * does not list (customers included) and lets every listed role through; the contract's "Roles:" line says
 * the same as the decorator; and one customer cannot read, change or delete another customer's things by id.
 */
const ROLES = ['support', 'catalog_editor', 'operator', 'admin', 'auditor'] as const;
const NAME = `(?:${ROLES.join('|')})`;
type Spec = { paths: Record<string, Record<string, { security?: unknown[]; description?: string }>> };
const spec = yaml.load(readFileSync(join(__dirname, '..', 'openapi.proposal.yaml'), 'utf8')) as Spec;
const routes = servedRoutes();
const shape = (path: string) => path.replace(/\{[^}]+\}/g, '{}');
const byShape = new Map(Object.entries(spec.paths).map(([p, item]) => [shape(p), item]));
const operation = (method: string, path: string) => byShape.get(shape(path))?.[method.toLowerCase()];
const isPublic = (method: string, path: string) => Array.isArray(operation(method, path)?.security) && operation(method, path)!.security!.length === 0;
/** A path with every parameter filled by a well-formed id that names nothing. */
const concrete = (path: string) => path.replace(/\{[^}]+\}/g, randomUUID());

describe('access matrix over every route', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());
  const send = (method: string, path: string, token?: string) => {
    const call = (http() as unknown as Record<string, (p: string) => request.Test>)[method.toLowerCase()](path);
    if (token) call.set('Authorization', `Bearer ${token}`);
    return call.set('Idempotency-Key', randomUUID()).set('If-Match', '"1"').send({});
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
    for (const role of ROLES) {
      await http().get('/v1/me').set('Authorization', `Bearer ${await id.token(`m-${role}`)}`).expect(200);
      expect(await runStaffCli(['grant', `m-${role}`, role, '--by', 'tar', '--reason', 'matrix test'], new Database(t.pool), () => undefined)).toBe(0);
    }
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('answers 401 without a token on every route that is not public', async () => {
    const open: string[] = [];
    for (const r of routes.filter((r) => !isPublic(r.method, r.path))) {
      const res = await send(r.method, concrete(r.path));
      if (res.status !== 401) open.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(open).toEqual([]);
  });

  it('puts every /v1/admin route behind @RequireRoles, and no other route', () => {
    expect(routes.filter((r) => r.path.startsWith('/v1/admin') !== (r.roles !== null)).map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it('documents the same roles in the contract as the code enforces', () => {
    const wrong: string[] = [];
    for (const r of routes.filter((r) => r.roles)) {
      const line = new RegExp(`Roles?: (${NAME}(?:(?:, | or )${NAME})*)`).exec(operation(r.method, r.path)?.description ?? '')?.[1] ?? '';
      const documented = line.split(/,\s*|\s+or\s+/).map((s) => s.trim()).filter(Boolean).sort();
      if (documented.join() !== [...r.roles!].sort().join()) wrong.push(`${r.method} ${r.path}: code ${r.roles!.join('/')} vs contract "${line}"`);
    }
    expect(wrong).toEqual([]);
  });

  it('refuses every role a staff route does not list, customers included, and lets each listed role past the role check', async () => {
    const wrong: string[] = [];
    const customer = await id.token('m-customer');
    const tokens = Object.fromEntries(await Promise.all(ROLES.map(async (r) => [r, await id.token(`m-${r}`)] as const)));
    for (const r of routes.filter((r) => r.roles)) {
      const path = concrete(r.path);
      for (const who of [...ROLES, 'customer'] as const) {
        const res = await send(r.method, path, who === 'customer' ? customer : tokens[who]);
        const allowed = who !== 'customer' && r.roles!.includes(who);
        const refused = res.status === 403 && res.body?.code === 'ROLE_REQUIRED';
        if (allowed === refused || res.status === 401) wrong.push(`${r.method} ${r.path} as ${who} → ${res.status} ${res.body?.code ?? ''}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("never lets one customer read, change or delete another customer's things by id", async () => {
    // Exports and device sign-out need a recent sign-in.
    const ann = { Authorization: `Bearer ${await id.token('m-ann', { authTime: Math.floor(Date.now() / 1000) })}` };
    const ben = { Authorization: `Bearer ${await id.token('m-ben', { authTime: Math.floor(Date.now() / 1000) })}` };
    const device = randomUUID();
    await http().put(`/v1/me/devices/${device}`).set(ann).send({ platform: 'android', osMajor: 15, appBuild: '1.0.0+42' }).expect(200);
    const event = { eventId: randomUUID(), eventName: 'playback_stall', schemaVersion: 1, monotonicMs: 120_000, sessionRandomId: 'sess_ab12cd34', durationMs: 3200, resultCode: 'MEDIA_STALLED', networkClass: 'cellular', appBuild: '1.0.0+42', osMajor: 15, deviceClass: 'phone' };
    const reportId = (await http().post('/v1/diagnostics/batches').set(ann).send({ batchId: randomUUID(), deviceId: device, consent: true, events: [event] }).expect(200)).body.reportId;
    const exportId = (await http().post('/v1/me/exports').set(ann).set('Idempotency-Key', randomUUID()).expect(202)).body.id;
    // Support redeems Ann's code, which gives Ann a grant she can withdraw.
    const code = (await http().post('/v1/me/support-access/codes').set(ann).expect(201)).body.code;
    const annId = (await http().get('/v1/me').set(ann).expect(200)).body.userId;
    const support = { Authorization: `Bearer ${await id.token('m-support')}` };
    const accessId = (await http().post(`/v1/admin/users/${annId}/diagnostics/access`).set(support).send({ code, reason: 'customer asked about stalls' }).expect(201)).body.id;
    expect([reportId, exportId, accessId].every((v) => typeof v === 'string')).toBe(true);

    const tries: [string, string][] = [
      ['DELETE', `/v1/me/devices/${device}/session`],
      ['GET', `/v1/me/devices/${device}/preferences`],
      ['PUT', `/v1/me/devices/${device}/preferences`],
      ['GET', `/v1/me/exports/${exportId}`],
      ['POST', `/v1/me/exports/${exportId}/link`],
      ['GET', `/v1/me/diagnostics/${reportId}`],
      ['DELETE', `/v1/me/diagnostics/${reportId}`],
      ['DELETE', `/v1/me/support-access/${accessId}`],
    ];
    const leaked: string[] = [];
    for (const [method, path] of tries) {
      const call = (http() as unknown as Record<string, (p: string) => request.Test>)[method.toLowerCase()](path).set(ben).set('If-Match', '"0"');
      const res = await call.send(method === 'PUT' ? { overrides: { theme: 'dark' } } : {});
      if (res.status !== 404) leaked.push(`${method} ${path} → ${res.status}`);
    }
    expect(leaked).toEqual([]);

    // Ben's own lists stay empty, and Ann still has everything.
    expect((await http().get('/v1/me/devices').set(ben).expect(200)).body.devices ?? []).toEqual([]);
    expect(JSON.stringify((await http().get('/v1/me/diagnostics').set(ben).expect(200)).body)).not.toContain(device);
    expect((await http().get(`/v1/me/devices/${device}/preferences`).set(ann)).status).toBe(200);
    expect((await http().get(`/v1/me/exports/${exportId}`).set(ann)).status).toBe(200);
    expect((await http().get(`/v1/me/diagnostics/${reportId}`).set(ann)).status).toBe(200);
    expect((await http().get('/v1/me/support-access').set(ann).expect(200)).body.grants.map((g: { id: string }) => g.id)).toContain(accessId);
  });
});
