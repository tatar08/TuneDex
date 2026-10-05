import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompactSign, createLocalJWKSet, exportJWK, importPKCS8, SignJWT } from 'jose';
import request from 'supertest';
import { BillingService } from '../src/billing/billing';
import type { GoogleFetch } from '../src/billing/google';
import { createIdentity, createTestApp, createTestDatabase, TestIdentity } from './harness';

/** A throwaway three-level chain shaped like Apple's (root → WWDR-like intermediate → signing leaf), made with openssl. */
function makeChain(dir: string, name: string, markers = true) {
  const f = (s: string) => join(dir, `${name}-${s}`);
  const ossl = (...args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' });
  writeFileSync(f('int.ext'), `basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n${markers ? '1.2.840.113635.100.6.2.1=ASN1:NULL\n' : ''}`);
  writeFileSync(f('leaf.ext'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n${markers ? '1.2.840.113635.100.6.11.1=ASN1:NULL\n' : ''}`);
  for (const k of ['root', 'int', 'leaf']) ossl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', f(`${k}.key`));
  ossl('req', '-x509', '-new', '-key', f('root.key'), '-subj', `/CN=${name} Root`, '-days', '30', '-out', f('root.pem'), '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
  ossl('req', '-new', '-key', f('int.key'), '-subj', `/CN=${name} Intermediate`, '-out', f('int.csr'));
  ossl('x509', '-req', '-in', f('int.csr'), '-CA', f('root.pem'), '-CAkey', f('root.key'), '-CAcreateserial', '-days', '30', '-extfile', f('int.ext'), '-out', f('int.pem'));
  ossl('req', '-new', '-key', f('leaf.key'), '-subj', `/CN=${name} Signing`, '-out', f('leaf.csr'));
  ossl('x509', '-req', '-in', f('leaf.csr'), '-CA', f('int.pem'), '-CAkey', f('int.key'), '-CAcreateserial', '-days', '30', '-extfile', f('leaf.ext'), '-out', f('leaf.pem'));
  const der = (p: string) => readFileSync(p, 'utf8').replace(/-----[^-]+-----|\s/g, '');
  return { rootPem: readFileSync(f('root.pem'), 'utf8').trim(), x5c: [der(f('leaf.pem')), der(f('int.pem')), der(f('root.pem'))], leafKey: readFileSync(f('leaf.key'), 'utf8') };
}

describe('Pro purchase verification (/v1/billing, /v1/webhooks)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: TestIdentity;
  let t: Awaited<ReturnType<typeof createTestApp>>;
  const http = () => request(t.app.getHttpServer());
  const bearer = async (sub: string) => ({ Authorization: `Bearer ${await id.token(sub)}` });
  const dir = mkdtempSync(join(tmpdir(), 'td-billing-'));
  const apple = makeChain(dir, 'apple');
  const rogue = makeChain(dir, 'rogue');
  const unmarked = makeChain(dir, 'plain', false);
  const userId: Record<string, string> = {};

  // Fake Google: OAuth token endpoint plus the purchases API, keyed by purchase token.
  const google = { purchases: new Map<string, { purchaseState: number; acknowledgementState: number; obfuscatedExternalAccountId?: string }>(), acks: [] as string[], down: false };
  const googleFetch: GoogleFetch = async (url, init) => {
    if (google.down) return { status: 503, json: async () => ({}) };
    if (url === 'https://oauth2.googleapis.com/token') return { status: 200, json: async () => ({ access_token: 'ya29.test', expires_in: 3600 }) };
    if (init?.headers?.authorization !== 'Bearer ya29.test') return { status: 401, json: async () => ({}) };
    const m = /\/applications\/app\.tunedeck\/purchases\/products\/([^/]+)\/tokens\/([^/:]+)(:acknowledge)?$/.exec(url);
    const p = m ? google.purchases.get(decodeURIComponent(m[2])) : undefined;
    if (!m || !p) return { status: 404, json: async () => ({}) };
    if (m[3]) {
      google.acks.push(decodeURIComponent(m[2]));
      p.acknowledgementState = 1;
      return { status: 204, json: async () => ({}) };
    }
    return { status: 200, json: async () => ({ ...p, purchaseTimeMillis: '1790000000000' }) };
  };
  const pushKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = generateKeyPairSync('rsa', { modulusLength: 2048 });

  beforeAll(async () => {
    db = await createTestDatabase();
    id = await createIdentity();
    const jwk = { ...(await exportJWK(pushKey.publicKey)), kid: 'g1', alg: 'RS256' };
    t = await createTestApp(db.url, id.keyResolver, {
      googleFetch,
      googlePushKeys: createLocalJWKSet({ keys: [jwk] }),
      config: {
        billing: {
          apple: { bundleId: 'app.tunedeck', rootCaPem: apple.rootPem, productIds: ['tunedeck.pro.lifetime'], environments: ['Production', 'Sandbox'] },
          google: {
            packageName: 'app.tunedeck',
            productIds: ['pro_lifetime'],
            serviceAccount: { clientEmail: 'play@test.iam.gserviceaccount.com', privateKeyPem: sa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
            pushAudience: 'https://api.test/v1/webhooks/google',
            pushServiceAccount: 'rtdn@test.iam.gserviceaccount.com',
          },
        },
      },
    });
    for (const sub of ['buyer', 'other', 'droid']) {
      await http().get('/v1/me/settings').set(await bearer(sub)).expect(200);
      userId[sub] = (await t.pool.query('SELECT id FROM users WHERE oidc_subject = $1', [sub])).rows[0].id;
    }
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  const sign = async (payload: object, chain = apple) =>
    new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader({ alg: 'ES256', x5c: chain.x5c }).sign(await importPKCS8(chain.leafKey, 'ES256'));
  const tx = (o: Partial<Record<string, unknown>> = {}) => ({
    transactionId: '2000000123',
    originalTransactionId: '2000000123',
    bundleId: 'app.tunedeck',
    productId: 'tunedeck.pro.lifetime',
    purchaseDate: 1790000000000,
    type: 'Non-Consumable',
    environment: 'Production',
    ...o,
  });
  const verifyApple = async (sub: string, signedTransaction: string) => http().post('/v1/billing/verify').set(await bearer(sub)).send({ store: 'apple', signedTransaction });

  it('verifies an Apple transaction once, replays safely, and never lets a second account claim it', async () => {
    expect((await http().get('/v1/me/entitlements').set(await bearer('buyer'))).body).toEqual({ pro: { apple: 'none', google: 'none' }, purchases: [] });
    const signed = await sign(tx({ appAccountToken: userId.buyer }));
    const first = await verifyApple('buyer', signed);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ store: 'apple', productId: 'tunedeck.pro.lifetime', state: 'verified', environment: 'production' });
    expect((await verifyApple('buyer', signed)).body.state).toBe('verified');
    expect((await http().get('/v1/me/entitlements').set(await bearer('buyer'))).body.pro).toEqual({ apple: 'verified', google: 'none' });

    // The same purchase sent by another account: refused, whether or not the app set the account token.
    expect((await verifyApple('other', await sign(tx()))).status).toBe(409);
    expect((await verifyApple('other', signed)).body).toMatchObject({ code: 'PURCHASE_INVALID', details: { reason: 'account_mismatch' } });

    const audit = await t.pool.query(`SELECT action, changes FROM audit_events WHERE target_type = 'purchase'`);
    expect(audit.rows).toEqual([{ action: 'purchase.verified', changes: { store: 'apple', productId: 'tunedeck.pro.lifetime', environment: 'production' } }]);
    // Only a digest of the transaction id is stored.
    const stored = JSON.stringify((await t.pool.query('SELECT * FROM purchases')).rows);
    expect(stored).not.toContain('2000000123');
  });

  it('refuses anything not signed through the pinned Apple root, or for another app or product', async () => {
    const reason = async (signed: string) => (await verifyApple('other', signed)).body.details?.reason;
    expect(await reason(await sign(tx({ originalTransactionId: '9' }), rogue))).toBe('signature');
    expect(await reason(await sign(tx({ originalTransactionId: '9' }), unmarked))).toBe('signature');
    const [h, , s] = (await sign(tx({ originalTransactionId: '9' }))).split('.');
    // The same signature over a different transaction id.
    const forged = Buffer.from(JSON.stringify(tx({ originalTransactionId: '10' }))).toString('base64url');
    expect(await reason(`${h}.${forged}.${s}`)).toBe('signature');
    expect(await reason(await sign(tx({ originalTransactionId: '9', bundleId: 'com.other' })))).toBe('wrong_app');
    expect(await reason(await sign(tx({ originalTransactionId: '9', productId: 'coins.100' })))).toBe('unknown_product');
    expect((await http().post('/v1/billing/verify').set(await bearer('other')).send({ store: 'apple', signedTransaction: 'nope', paid: true })).status).toBe(400);
    expect((await http().post('/v1/billing/verify').send({ store: 'apple', signedTransaction: await sign(tx()) })).status).toBe(401);
    expect((await t.pool.query(`SELECT 1 FROM purchases WHERE user_id = $1`, [userId.other])).rows).toEqual([]);
  });

  it('revokes on an App Store refund notification, once, a later verify cannot undo it, and a reversed refund gives Pro back', async () => {
    const notification = async (type: string, uuid: string, chain = apple) =>
      http().post('/v1/webhooks/apple').send({ signedPayload: await sign({ notificationType: type, notificationUUID: uuid, data: { bundleId: 'app.tunedeck', environment: 'Production', signedTransactionInfo: await sign(tx()) } }, chain) });
    expect((await notification('REFUND', randomUUID(), rogue)).status).toBe(401);
    const uuid = randomUUID();
    expect((await notification('REFUND', uuid)).status).toBe(200);
    expect((await notification('REFUND', uuid)).status).toBe(200);
    expect((await http().get('/v1/me/entitlements').set(await bearer('buyer'))).body.pro.apple).toBe('revoked');
    expect((await verifyApple('buyer', await sign(tx({ appAccountToken: userId.buyer })))).body.state).toBe('revoked');
    const revoked = await t.pool.query(`SELECT actor, changes FROM audit_events WHERE action = 'purchase.revoked'`);
    expect(revoked.rows).toEqual([{ actor: 'system:apple', changes: { store: 'apple', productId: 'tunedeck.pro.lifetime', reason: 'refund' } }]);

    // Apple reverses the refund: Pro comes back, audited; a reversal whose transaction is still revoked changes nothing.
    const reversal = async (uuid: string, t2: object) =>
      http().post('/v1/webhooks/apple').send({ signedPayload: await sign({ notificationType: 'REFUND_REVERSED', notificationUUID: uuid, data: { bundleId: 'app.tunedeck', environment: 'Production', signedTransactionInfo: await sign(t2) } }) });
    expect((await reversal(randomUUID(), tx({ revocationDate: 1790000500000 }))).status).toBe(200);
    expect((await http().get('/v1/me/entitlements').set(await bearer('buyer'))).body.pro.apple).toBe('revoked');
    expect((await reversal(randomUUID(), tx())).status).toBe(200);
    expect((await http().get('/v1/me/entitlements').set(await bearer('buyer'))).body.pro.apple).toBe('verified');
    const restored = await t.pool.query(`SELECT actor, changes FROM audit_events WHERE action = 'purchase.restored'`);
    expect(restored.rows).toEqual([{ actor: 'system:apple', changes: { store: 'apple', productId: 'tunedeck.pro.lifetime', reason: 'refund_reversed' } }]);
  });

  it('verifies a Google purchase with the Play API, acknowledges it after storing, and handles pending and voided purchases', async () => {
    const d = await bearer('droid');
    const verify = (purchaseToken: string, productId = 'pro_lifetime') => http().post('/v1/billing/verify').set(d).send({ store: 'google', productId, purchaseToken });
    google.purchases.set('tok-paid-0001', { purchaseState: 0, acknowledgementState: 0 });
    expect((await verify('tok-paid-0001')).body).toMatchObject({ store: 'google', state: 'verified' });
    expect(google.acks).toEqual(['tok-paid-0001']);
    expect((await verify('tok-unknown-01')).body.details).toEqual({ reason: 'unknown_purchase' });
    expect((await verify('tok-paid-0001', 'coins_100')).body.details).toEqual({ reason: 'unknown_product' });

    // A store outage grants nothing new.
    google.purchases.set('tok-outage-01', { purchaseState: 0, acknowledgementState: 0 });
    google.down = true;
    expect((await verify('tok-outage-01')).status).toBe(503);
    google.down = false;

    // Pending: no Pro and no acknowledgement until Google says it completed.
    google.purchases.set('tok-pending-1', { purchaseState: 2, acknowledgementState: 0 });
    expect((await verify('tok-pending-1')).body.state).toBe('pending');
    expect(google.acks).toEqual(['tok-paid-0001']);

    const push = async (data: object, token?: string, messageId: string = randomUUID()) =>
      http()
        .post('/v1/webhooks/google')
        .set('Authorization', `Bearer ${token ?? (await pushToken())}`)
        .send({ message: { messageId, data: Buffer.from(JSON.stringify({ packageName: 'app.tunedeck', ...data })).toString('base64') }, subscription: 'projects/p/subscriptions/s' });
    const pushToken = (o: { aud?: string; email?: string } = {}) =>
      new SignJWT({ email: o.email ?? 'rtdn@test.iam.gserviceaccount.com', email_verified: true })
        .setProtectedHeader({ alg: 'RS256', kid: 'g1' })
        .setIssuer('https://accounts.google.com')
        .setAudience(o.aud ?? 'https://api.test/v1/webhooks/google')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(pushKey.privateKey);
    expect((await push({ testNotification: {} }, await pushToken({ email: 'someone@evil.test' }))).status).toBe(401);
    expect((await push({ testNotification: {} }, await pushToken({ aud: 'https://other' }))).status).toBe(401);
    expect((await push({ testNotification: {} })).status).toBe(204);

    google.purchases.get('tok-pending-1')!.purchaseState = 0;
    // Play is down for the first delivery: the notification is not swallowed, Pub/Sub's redelivery completes it.
    const completed = { oneTimeProductNotification: { notificationType: 1, purchaseToken: 'tok-pending-1', sku: 'pro_lifetime' } };
    google.down = true;
    expect((await push(completed, undefined, 'msg-retry-1')).status).toBe(503);
    google.down = false;
    expect((await push(completed, undefined, 'msg-retry-1')).status).toBe(204);
    expect(google.acks).toEqual(['tok-paid-0001', 'tok-pending-1']);
    expect((await push({ voidedPurchaseNotification: { purchaseToken: 'tok-paid-0001', productType: 2 } })).status).toBe(204);
    const ent = (await http().get('/v1/me/entitlements').set(d)).body;
    expect(ent.purchases.map((p: { state: string }) => p.state)).toEqual(['revoked', 'verified']);
    expect(ent.pro).toEqual({ apple: 'none', google: 'verified' });
  });

  it('lets a purchase whose account was deleted be restored by the new account', async () => {
    await t.pool.query(`UPDATE users SET status = 'deleted' WHERE id = $1`, [userId.droid]);
    const res = await http().post('/v1/billing/verify').set(await bearer('other')).send({ store: 'google', productId: 'pro_lifetime', purchaseToken: 'tok-pending-1' });
    expect(res.body.state).toBe('verified');
    const moved = await t.pool.query(`SELECT changes FROM audit_events WHERE action = 'purchase.verified' AND actor = $1 AND changes->>'store' = 'google'`, [`user:${userId.other}`]);
    expect(moved.rows[0].changes).toMatchObject({ store: 'google', fromDeletedAccount: true });
  });

  it('answers 503 and grants nothing when a store is not configured; its webhooks answer like a bad signature', async () => {
    const bare = await createTestApp(db.url, id.keyResolver);
    try {
      const res = await request(bare.app.getHttpServer()).post('/v1/billing/verify').set(await bearer('other')).send({ store: 'apple', signedTransaction: await sign(tx({ originalTransactionId: '77' })) });
      expect(res.status).toBe(503);
      // An anonymous caller cannot tell an unconfigured store from a configured one.
      expect((await request(bare.app.getHttpServer()).post('/v1/webhooks/google').send({})).status).toBe(401);
      expect((await request(bare.app.getHttpServer()).post('/v1/webhooks/apple').send({})).status).toBe(401);
      expect((await http().post('/v1/webhooks/google').send({})).status).toBe(401);
    } finally {
      await bare.close();
    }
  });

  it('acknowledges an App Store notification from an environment it does not accept, and changes nothing', async () => {
    const prodOnly = await createTestApp(db.url, id.keyResolver, {
      config: { billing: { apple: { bundleId: 'app.tunedeck', rootCaPem: apple.rootPem, productIds: ['tunedeck.pro.lifetime'], environments: ['Production'] }, google: null } },
    });
    try {
      const sandboxTx = tx({ originalTransactionId: 'sbx-0001', transactionId: 'sbx-0001', environment: 'Sandbox', appAccountToken: userId.other });
      expect((await verifyApple('other', await sign(sandboxTx))).body.state).toBe('verified');
      const payload = await sign({ notificationType: 'REFUND', notificationUUID: randomUUID(), data: { bundleId: 'app.tunedeck', environment: 'Sandbox', signedTransactionInfo: await sign(sandboxTx) } });
      expect((await request(prodOnly.app.getHttpServer()).post('/v1/webhooks/apple').send({ signedPayload: payload })).status).toBe(200);
      const states = (await t.pool.query(`SELECT state FROM purchases WHERE user_id = $1 AND environment = 'sandbox'`, [userId.other])).rows;
      expect(states).toEqual([{ state: 'verified' }]);
    } finally {
      await prodOnly.close();
    }
  });

  it('forgets handled notification ids after 30 days, keeping recent ones', async () => {
    await t.pool.query(`INSERT INTO store_notifications (store, digest, kind, received_at) VALUES ('google', 'old-1', 'voided', now() - interval '31 days'), ('google', 'new-1', 'voided', now() - interval '29 days')`);
    expect(await t.app.get(BillingService).pruneNotifications()).toBeGreaterThanOrEqual(1);
    const left = (await t.pool.query(`SELECT digest FROM store_notifications WHERE digest IN ('old-1', 'new-1')`)).rows.map((r) => r.digest);
    expect(left).toEqual(['new-1']);
  });
});
