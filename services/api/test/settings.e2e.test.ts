import request from 'supertest';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

describe('GET/PATCH /v1/me/settings', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  describe('authentication', () => {
    it('rejects a request without a token with 401 and the error envelope', async () => {
      const res = await http().get('/v1/me/settings').set('X-Request-Id', 'test-req-0001');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        code: 'AUTH_REQUIRED',
        messageKey: 'errors.auth.required',
        requestId: 'test-req-0001',
        details: {},
      });
      expect(res.headers['x-request-id']).toBe('test-req-0001');
    });

    it.each([
      ['wrong issuer', { iss: 'https://evil.test' }],
      ['wrong audience', { aud: 'another-api' }],
      ['expired', { expSeconds: -60 }],
      ['unknown key id', { kid: 'not-in-jwks' }],
    ])('rejects a token with %s', async (_label, overrides) => {
      const token = await id.token('user-a', overrides);
      const res = await http().get('/v1/me/settings').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_REQUIRED');
    });

    it('rejects a token signed by a key that is not in the JWKS', async () => {
      const token = await id.token('user-a', { key: id.foreignKey });
      const res = await http().get('/v1/me/settings').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it('rejects an unsigned (alg=none) token', async () => {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const token = `${b64({ alg: 'none' })}.${b64({ sub: 'user-a', iss: 'https://idp.test/realms/tunedeck', aud: 'tunedeck-api', exp: now + 300 })}.`;
      const res = await http().get('/v1/me/settings').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it('returns 403 for an account that is being deleted', async () => {
      const token = await id.token('user-deleting');
      await http().get('/v1/me/settings').set('Authorization', `Bearer ${token}`).expect(200);
      await t.pool.query(`UPDATE users SET status = 'deleting' WHERE oidc_subject = 'user-deleting'`);
      const res = await http().get('/v1/me/settings').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ACCOUNT_DELETING');
    });
  });

  describe('read and update', () => {
    it('returns defaults at revision 0 for a new account', async () => {
      const token = await id.token('user-new');
      const res = await http().get('/v1/me/settings').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.headers.etag).toBe('"0"');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        revision: 0,
        schemaVersion: 1,
        settings: { theme: 'system', language: 'th', cellularPolicy: 'allow' },
        updatedAt: null,
      });
    });

    it('persists a change and returns it on reload with the next revision', async () => {
      const token = await id.token('user-persist');
      const patched = await http()
        .patch('/v1/me/settings')
        .set('Authorization', `Bearer ${token}`)
        .set('If-Match', '"0"')
        .send({ theme: 'dark' });
      expect(patched.status).toBe(200);
      expect(patched.headers.etag).toBe('"1"');
      expect(patched.body.settings.theme).toBe('dark');

      const second = await http()
        .patch('/v1/me/settings')
        .set('Authorization', `Bearer ${token}`)
        .set('If-Match', '"1"')
        .send({ language: 'en' });
      expect(second.status).toBe(200);

      const reloaded = await http().get('/v1/me/settings').set('Authorization', `Bearer ${token}`);
      expect(reloaded.body.revision).toBe(2);
      expect(reloaded.body.settings).toEqual({ theme: 'dark', language: 'en', cellularPolicy: 'allow' });
      expect(new Date(reloaded.body.updatedAt).toISOString()).toBe(reloaded.body.updatedAt);
    });

    it('keeps two accounts isolated from each other', async () => {
      const a = await id.token('user-iso-a');
      const b = await id.token('user-iso-b');
      await http().patch('/v1/me/settings').set('Authorization', `Bearer ${a}`).set('If-Match', '"0"').send({ theme: 'light' }).expect(200);

      const bView = await http().get('/v1/me/settings').set('Authorization', `Bearer ${b}`);
      expect(bView.body.revision).toBe(0);
      expect(bView.body.settings.theme).toBe('system');

      // B writing at revision 0 creates B's own row and leaves A untouched.
      await http().patch('/v1/me/settings').set('Authorization', `Bearer ${b}`).set('If-Match', '"0"').send({ theme: 'dark' }).expect(200);
      const aView = await http().get('/v1/me/settings').set('Authorization', `Bearer ${a}`);
      expect(aView.body.settings.theme).toBe('light');
      expect(aView.body.revision).toBe(1);
    });

    it('ignores any owner or user id supplied in the body', async () => {
      const a = await id.token('user-body-a');
      const res = await http().patch('/v1/me/settings').set('Authorization', `Bearer ${a}`).set('If-Match', '"0"').send({ userId: 'someone-else', theme: 'dark' });
      expect(res.status).toBe(400);
      expect(res.body.details).toEqual({ field: 'userId', reason: 'unknown_field' });
    });
  });

  describe('validation', () => {
    let token: string;
    beforeAll(async () => {
      token = await id.token('user-validation');
    });
    const patch = (body: unknown, ifMatch: string | null = '"0"') => {
      const r = http().patch('/v1/me/settings').set('Authorization', `Bearer ${token}`);
      if (ifMatch !== null) r.set('If-Match', ifMatch);
      return r.send(body as object);
    };

    it('rejects a value outside the allowlist', async () => {
      const res = await patch({ theme: 'cockpit-dark' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.details).toEqual({ field: 'theme', reason: 'value_not_allowed', allowed: ['system', 'light', 'dark'] });
    });

    it('rejects a non-string value', async () => {
      expect((await patch({ language: 1 })).status).toBe(400);
    });

    it('rejects an empty patch', async () => {
      expect((await patch({})).body.details).toEqual({ reason: 'empty_patch' });
    });

    it('rejects a JSON array body', async () => {
      expect((await patch([{ theme: 'dark' }])).status).toBe(400);
    });

    it('rejects malformed JSON with the envelope', async () => {
      const res = await http()
        .patch('/v1/me/settings')
        .set('Authorization', `Bearer ${token}`)
        .set('If-Match', '"0"')
        .set('Content-Type', 'application/json')
        .send('{"theme":');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('requires If-Match (428)', async () => {
      const res = await patch({ theme: 'dark' }, null);
      expect(res.status).toBe(428);
      expect(res.body.code).toBe('PRECONDITION_REQUIRED');
    });

    it.each(['*', 'W/"0"', '0', '"abc"'])('rejects If-Match %s', async (value) => {
      expect((await patch({ theme: 'dark' }, value)).status).toBe(400);
    });

    it('rejects an oversized body with 413', async () => {
      const res = await patch({ theme: 'x'.repeat(20_000) });
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('does not write anything when validation fails', async () => {
      const res = await http().get('/v1/me/settings').set('Authorization', `Bearer ${token}`);
      expect(res.body.revision).toBe(0);
    });
  });

  describe('optimistic concurrency', () => {
    it('returns 412 with the current revision when the client is stale', async () => {
      const token = await id.token('user-stale');
      await http().patch('/v1/me/settings').set('Authorization', `Bearer ${token}`).set('If-Match', '"0"').send({ theme: 'dark' }).expect(200);
      const stale = await http().patch('/v1/me/settings').set('Authorization', `Bearer ${token}`).set('If-Match', '"0"').send({ theme: 'light' });
      expect(stale.status).toBe(412);
      expect(stale.body.code).toBe('REVISION_MISMATCH');
      expect(stale.body.details).toEqual({ currentRevision: 1 });

      const view = await http().get('/v1/me/settings').set('Authorization', `Bearer ${token}`);
      expect(view.body.settings.theme).toBe('dark');
    });

    it('lets exactly one of two concurrent writers at the same revision win', async () => {
      const token = await id.token('user-race');
      const send = (theme: string) =>
        http().patch('/v1/me/settings').set('Authorization', `Bearer ${token}`).set('If-Match', '"0"').send({ theme });
      const results = await Promise.all([send('dark'), send('light'), send('system')]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 412, 412]);
    });

    it('returns 412 for a revision ahead of the server', async () => {
      const token = await id.token('user-ahead');
      const res = await http().patch('/v1/me/settings').set('Authorization', `Bearer ${token}`).set('If-Match', '"5"').send({ theme: 'dark' });
      expect(res.status).toBe(412);
      expect(res.body.details).toEqual({ currentRevision: 0 });
    });
  });

  describe('logging', () => {
    it('writes one structured line per request without tokens, query strings or bodies', async () => {
      const token = await id.token('user-logs');
      const logs = t.logs;
      logs.mark();
      await http().get('/v1/me/settings?email=a@example.com').set('Authorization', `Bearer ${token}`).set('X-Request-Id', 'log-check-0001');
      await http().patch('/v1/me/settings').set('Authorization', `Bearer ${token}`).set('If-Match', '"0"').send({ theme: 'dark' });
      const raw = logs.raw();
      expect(logs.lines()).toHaveLength(2);
      expect(raw).not.toContain(token);
      expect(raw).not.toContain('a@example.com');
      expect(raw).not.toContain('user-logs');
      expect(raw).not.toContain('"theme"');
      const line = logs.lines().find((l) => l.requestId === 'log-check-0001')!;
      expect(line).toMatchObject({
        severity: 'INFO',
        service: 'api',
        environment: 'dev',
        eventCode: 'HTTP_REQUEST',
        method: 'GET',
        route: '/v1/me/settings',
        status: 200,
      });
      expect(typeof line.durationMs).toBe('number');
      expect(line.actorId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('replaces an unsafe inbound request id', async () => {
      const res = await http().get('/health/live').set('X-Request-Id', 'bad id<script>');
      expect(res.headers['x-request-id']).toMatch(/^req_[0-9a-f-]{36}$/);
    });
  });
});
