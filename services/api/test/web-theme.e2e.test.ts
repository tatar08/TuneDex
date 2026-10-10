import request from 'supertest';
import { Database } from '../src/db/database';
import { runStaffCli } from '../src/staff/staff-cli';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

describe('web app layout theme', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let tokens: Record<'admin' | 'editor' | 'user', string>;
  const http = () => request(t.app.getHttpServer());
  const as = (who: keyof typeof tokens) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    t = await createTestApp(db.url, id.keyResolver);
    tokens = { admin: await id.token('theme-admin'), editor: await id.token('theme-editor'), user: await id.token('theme-user') };
    const staff = (...args: string[]) => runStaffCli(args, new Database(t.pool), () => undefined);
    for (const who of Object.keys(tokens) as (keyof typeof tokens)[]) await http().get('/v1/me').set(as(who)).expect(200);
    expect(await staff('grant', 'theme-admin', 'admin', '--by', 'tar', '--reason', 'owner')).toBe(0);
    expect(await staff('grant', 'theme-editor', 'catalog_editor', '--by', 'tar', '--reason', 'catalog team')).toBe(0);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('is classic until an admin chooses another, which everyone then reads without signing in', async () => {
    const first = await http().get('/v1/brand/web-theme').expect(200);
    expect(first.body).toEqual({ theme: 'classic' });
    expect(first.headers['cache-control']).toBe('public, max-age=60');
    expect((await http().get('/v1/admin/brand/web-theme').set(as('admin')).expect(200)).body).toEqual({ theme: 'classic', updatedBy: null, updatedAt: null });

    const set = await http().post('/v1/admin/brand/web-theme').set(as('admin')).send({ theme: 'radio-wall' }).expect(200);
    expect(set.body).toMatchObject({ theme: 'radio-wall', updatedBy: 'theme-admin' });
    expect((await http().get('/v1/brand/web-theme').expect(200)).body).toEqual({ theme: 'radio-wall' });
    await http().post('/v1/admin/brand/web-theme').set(as('admin')).send({ theme: 'classic' }).expect(200);
    expect((await http().get('/v1/brand/web-theme').expect(200)).body).toEqual({ theme: 'classic' });

    const audit = await t.pool.query<{ action: string; changes: unknown }>(`SELECT action, changes FROM audit_events WHERE action = 'brand.web_theme.set' ORDER BY id`);
    expect(audit.rows).toEqual([
      { action: 'brand.web_theme.set', changes: { from: 'classic', to: 'radio-wall' } },
      { action: 'brand.web_theme.set', changes: { from: 'radio-wall', to: 'classic' } },
    ]);
  });

  it('refuses anything that is not a theme id, and everyone but admins', async () => {
    for (const body of [{ theme: 'Radio Wall' }, { theme: '' }, { theme: 'x'.repeat(40) }, { theme: '<script>' }, { theme: 'classic', extra: 1 }, {}]) {
      expect((await http().post('/v1/admin/brand/web-theme').set(as('admin')).send(body)).status).toBe(400);
    }
    for (const who of ['editor', 'user'] as const) {
      expect((await http().post('/v1/admin/brand/web-theme').set(as(who)).send({ theme: 'radio-wall' })).status).toBe(403);
      expect((await http().get('/v1/admin/brand/web-theme').set(as(who))).status).toBe(403);
    }
    expect((await http().post('/v1/admin/brand/web-theme').send({ theme: 'radio-wall' })).status).toBe(401);
    expect((await http().get('/v1/brand/web-theme').expect(200)).body).toEqual({ theme: 'classic' });
  });
});
