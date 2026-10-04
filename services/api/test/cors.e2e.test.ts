import request from 'supertest';
import { createIdentity, createTestApp, createTestDatabase } from './harness';

describe('CORS allowlist (Doc 17)', () => {
  it('answers only listed origins, and sends nothing when the list is empty', async () => {
    const db = await createTestDatabase();
    const id = await createIdentity();
    const open = await createTestApp(db.url, id.keyResolver, { config: { corsAllowedOrigins: ['https://web.example'] } });
    const closed = await createTestApp(db.url, id.keyResolver);
    try {
      const preflight = (app: typeof open, origin: string) =>
        request(app.app.getHttpServer()).options('/v1/me/settings').set('Origin', origin).set('Access-Control-Request-Method', 'PATCH');
      const allowed = await preflight(open, 'https://web.example');
      expect(allowed.headers['access-control-allow-origin']).toBe('https://web.example');
      expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();
      expect((await preflight(open, 'https://evil.example')).headers['access-control-allow-origin']).toBeUndefined();
      expect((await preflight(closed, 'https://web.example')).headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await open.close();
      await closed.close();
      await db.drop();
    }
  });
});
