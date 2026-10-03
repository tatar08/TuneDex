import request from 'supertest';
import { createIdentity, createTestApp, createTestDatabase } from './harness';

describe('health probes', () => {
  it('reports live and ready when the database is reachable', async () => {
    const db = await createTestDatabase();
    const id = await createIdentity();
    const t = await createTestApp(db.url, id.keyResolver);
    try {
      await request(t.app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' });
      await request(t.app.getHttpServer()).get('/health/ready').expect(200, { status: 'ok' });
    } finally {
      await t.close();
      await db.drop();
    }
  });
});

describe('database unavailable', () => {
  // Port 1 refuses connections, standing in for a database outage.
  const DOWN = 'postgres://postgres@127.0.0.1:1/tunedeck';

  it('stays live, reports not ready, and returns 503 for settings without leaking details', async () => {
    const id = await createIdentity();
    const t = await createTestApp(DOWN, id.keyResolver);
    try {
      const http = request(t.app.getHttpServer());
      await http.get('/health/live').expect(200);
      await request(t.app.getHttpServer()).get('/health/ready').expect(503, { status: 'unavailable' });

      const token = await id.token('user-db-down');
      const res = await request(t.app.getHttpServer()).get('/v1/me/settings').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('DEPENDENCY_UNAVAILABLE');
      expect(res.body.details).toEqual({});
      expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|postgres/);
    } finally {
      await t.close();
    }
  });

  it('fails closed with 503 when the signing keys cannot be fetched', async () => {
    const db = await createTestDatabase();
    const id = await createIdentity();
    const unreachableKeys = async () => {
      throw new Error('JWKS fetch failed');
    };
    const t = await createTestApp(db.url, unreachableKeys);
    try {
      const token = await id.token('user-jwks-down');
      const res = await request(t.app.getHttpServer()).get('/v1/me/settings').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('DEPENDENCY_UNAVAILABLE');
    } finally {
      await t.close();
      await db.drop();
    }
  });
});

describe('unknown routes', () => {
  it('returns the error envelope for 404', async () => {
    const id = await createIdentity();
    const t = await createTestApp('postgres://postgres@127.0.0.1:1/x', id.keyResolver);
    try {
      const res = await request(t.app.getHttpServer()).get('/v1/nope');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    } finally {
      await t.close();
    }
  });
});
