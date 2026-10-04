import { expect, test } from '@playwright/test';
import { startStack, Stack } from './stack';

let stack: Stack;
let idp: Stack['idp'];
let api: Stack['api'];
let base: string;

test.beforeAll(async () => {
  stack = await startStack();
  ({ idp, api, base } = stack);
});

test.afterAll(async () => {
  await stack?.stop();
});

test('sign in, save by keyboard, resolve a conflict, sign out', async ({ browser }) => {
  idp.setUser('e2e-alice');
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${base}/app/settings`);
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await page.getByRole('link', { name: 'เข้าสู่ระบบ' }).click();
  await expect(page).toHaveURL(`${base}/app/settings`);
  await expect(page.getByRole('heading', { name: 'การตั้งค่า' })).toBeVisible();
  await expect(page.getByText('ยังไม่เคยบันทึก ใช้ค่าเริ่มต้นอยู่')).toBeVisible();

  // Tokens stay on the server: only an HttpOnly session cookie reaches the browser.
  const cookies = await context.cookies();
  expect(cookies.map((c) => c.name)).toEqual(['td_session']);
  expect(cookies[0]).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
  expect(await page.evaluate(() => [document.cookie, Object.keys(localStorage).length, Object.keys(sessionStorage).length])).toEqual(['', 0, 0]);
  // The session lives in the shared PostgreSQL store, keyed by a hash of the cookie, not the cookie itself.
  const rows = (await stack.api.sql('SELECT key FROM console_sessions')) as { rows: { key: string }[] };
  expect(rows.rows.length).toBeGreaterThan(0);
  expect(rows.rows.map((r) => r.key)).not.toContain(cookies[0].value);

  // Keyboard only: focus the theme group, pick "dark", tab to Save, press Enter.
  await page.getByRole('radio', { name: 'ตามระบบ' }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'มืด' })).toBeChecked();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'บันทึก' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('saved-revision')).toHaveText('บันทึกแล้ว · revision 1');
  if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/settings.png`, fullPage: true });

  // A second browser changes the same account, so the first one is now stale.
  const other = await (await browser.newContext()).newPage();
  await other.goto(`${base}/auth/login`);
  await expect(other).toHaveURL(`${base}/app/settings`);
  await other.getByRole('radio', { name: 'เฉพาะ Wi-Fi' }).check();
  await other.getByRole('button', { name: 'บันทึก' }).click();
  await expect(other.getByTestId('saved-revision')).toHaveText('บันทึกแล้ว · revision 2');

  await page.getByRole('radio', { name: 'สว่าง' }).check();
  await page.getByRole('button', { name: 'บันทึก' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'revision' });
  await expect(alert).toContainText('revision 2');
  await expect(alert).toBeFocused();
  await page.getByRole('button', { name: 'บันทึกค่าของฉันทับ' }).click();
  await expect(page.getByTestId('saved-revision')).toHaveText('บันทึกแล้ว · revision 3');

  await page.reload();
  await expect(page.getByRole('radio', { name: 'สว่าง' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'เฉพาะ Wi-Fi' })).toBeChecked();
  await expect(page.getByText(/ยังไม่มีอุปกรณ์ที่ลงชื่อเข้าใช้/)).toBeVisible();

  // The phone app checks in: first still on revision 2, then after applying revision 3.
  const phone = await idp.accessTokenFor('e2e-alice');
  const checkIn = (applied: number) =>
    fetch(`${api.url}/v1/me/devices/7c2e9d10-3b4a-4f5e-8a6b-9c0d1e2f3a4b`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${phone}`, 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'ios', osMajor: 18, appBuild: '1.0.0+42', appliedSettingsRevision: applied }),
    });
  expect((await checkIn(2)).status).toBe(200);
  await page.reload();
  const device = page.getByTestId('device');
  await expect(device).toContainText('iPhone · iOS 18');
  await expect(device).toContainText('รอซิงก์');
  expect((await checkIn(3)).status).toBe(200);
  await page.reload();
  await expect(device).toContainText('ใช้ค่าล่าสุดแล้ว');

  await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
  await expect(page).toHaveURL(`${base}/login?signedOut=1`);
  await expect(page.getByText('ออกจากระบบแล้ว')).toBeVisible();
  await page.goto(`${base}/app/settings`);
  await expect(page).toHaveURL(/\/login/);
});

test('the privacy page lists the account’s diagnostic reports and deletes one', async ({ browser }) => {
  const token = await idp.accessTokenFor('e2e-dana');
  const call = (path: string, method: string, body: object) =>
    fetch(`${api.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const device = crypto.randomUUID();
  expect((await call(`/v1/me/devices/${device}`, 'PUT', { platform: 'ios', osMajor: 18, appBuild: '1.0.0' })).status).toBe(200);
  const ev = (eventName: string) => ({
    eventId: crypto.randomUUID(), eventName, schemaVersion: 1, monotonicMs: 5000, sessionRandomId: 'sess_e2e_0001',
    networkClass: 'wifi', appBuild: '1.0.0', osMajor: 18, deviceClass: 'phone',
  });
  for (const events of [[ev('playback_stall'), ev('playback_recovered')], [ev('app_error')]]) {
    expect((await call('/v1/diagnostics/batches', 'POST', { batchId: crypto.randomUUID(), deviceId: device, consent: true, events })).status).toBe(200);
  }

  idp.setUser('e2e-dana');
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${base}/auth/login?returnTo=/app/settings`);
  await page.getByRole('link', { name: 'ความเป็นส่วนตัว' }).click();
  await expect(page).toHaveURL(`${base}/app/privacy`);
  await expect(page.getByRole('heading', { name: 'ความเป็นส่วนตัว' })).toBeVisible();
  const reports = page.getByTestId('report');
  await expect(reports).toHaveCount(2);
  await expect(reports.first()).toContainText('iPhone · 1 เหตุการณ์');
  await expect(page.getByText('กลับมาเล่นได้ ×1 · เสียงสะดุด ×1')).toBeVisible();
  await expect(page.getByText('ระบบลบรายงานเองเมื่อครบ 7 วัน หรือคุณลบเองได้ทันที')).toBeVisible();
  if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/privacy.png`, fullPage: true });

  await reports.first().getByRole('button', { name: 'ลบรายงานนี้' }).click();
  await expect(reports).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId('report')).toHaveCount(1);
});

test('signing a phone out from the web asks for a fresh sign-in first', async ({ browser }) => {
  const token = await idp.accessTokenFor('e2e-erin');
  const register = (id: string, platform: string, osMajor: number) =>
    fetch(`${api.url}/v1/me/devices/${id}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ platform, osMajor, appBuild: '1.0.0+42', appliedSettingsRevision: 0 }),
    });
  const lost = crypto.randomUUID();
  expect((await register(lost, 'android', 15)).status).toBe(200);
  expect((await register(crypto.randomUUID(), 'ios', 18)).status).toBe(200);

  // An old SSO sign-in: the web session works, but it is too old to sign a device out.
  idp.setUser('e2e-erin');
  const first = await (await browser.newContext()).newPage();
  await first.goto(`${base}/auth/login`);
  await first.close();
  idp.ageSignIn(600);
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${base}/auth/login?returnTo=/app/settings`);
  await page.getByRole('link', { name: 'จัดการอุปกรณ์' }).click();
  await expect(page).toHaveURL(`${base}/app/devices`);
  await expect(page.getByRole('heading', { name: 'อุปกรณ์', exact: true })).toBeVisible();
  const devices = page.getByTestId('device');
  await expect(devices).toHaveCount(2);
  // Codes the customer can read out to support: the account id and each device id.
  const me = (await (await fetch(`${api.url}/v1/me`, { headers: { authorization: `Bearer ${token}` } })).json()) as { userId: string };
  await expect(page.getByRole('heading', { name: 'รหัสสำหรับติดต่อซัพพอร์ต' })).toBeVisible();
  await expect(page.locator('.support-code code').filter({ hasText: me.userId })).toBeVisible();
  await expect(devices.filter({ hasText: 'Android 15' }).locator('code')).toHaveText(lost);
  if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/devices-support-code.png`, fullPage: true });

  const android = devices.filter({ hasText: 'Android 15' });
  await android.getByRole('button', { name: 'ออกจากระบบเครื่องนี้' }).click();
  await expect(android).toContainText('ออกจากระบบ Android 15 ใช่ไหม');
  await expect(android.getByRole('button', { name: 'ยืนยัน ออกจากระบบ' })).toBeFocused();
  if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/devices-confirm.png`, fullPage: true });
  await page.keyboard.press('Enter');

  const alert = page.getByRole('alert').filter({ hasText: 'ยืนยันตัวตน' });
  await expect(alert).toContainText('กรุณายืนยันตัวตนอีกครั้ง');
  await expect(alert).toBeFocused();
  if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/devices-reauth.png`, fullPage: true });
  await expect(devices).toHaveCount(2);

  // Back from the provider, the same phone is still chosen and only needs the final click.
  await alert.getByRole('link', { name: 'ยืนยันตัวตน' }).click();
  await expect(page).toHaveURL(`${base}/app/devices`);
  const confirm = page.getByRole('button', { name: 'ยืนยัน ออกจากระบบ' });
  await expect(confirm).toBeFocused();
  await confirm.click();
  await expect(devices).toHaveCount(1);
  await expect(page.getByTestId('revoked-device')).toContainText('Android 15');
  await expect(page.getByText('ออกจากระบบ Android 15 แล้ว')).toBeAttached();
  if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/devices-done.png`, fullPage: true });

  // The phone itself is now refused, and a reload keeps the result without reopening the confirmation.
  expect((await register(lost, 'android', 15)).status).toBe(403);
  await page.reload();
  await expect(page.getByTestId('revoked-device')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'ยืนยัน ออกจากระบบ' })).toHaveCount(0);
});

test('download my data, then delete the account after a fresh sign-in', async ({ browser }) => {
  const phone = await idp.accessTokenFor('e2e-fern');
  const device = crypto.randomUUID();
  const checkIn = () =>
    fetch(`${api.url}/v1/me/devices/${device}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${phone}`, 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'ios', osMajor: 18, appBuild: '1.0.0+42', appliedSettingsRevision: 0 }),
    });
  expect((await checkIn()).status).toBe(200);

  idp.setUser('e2e-fern');
  const first = await (await browser.newContext()).newPage();
  await first.goto(`${base}/auth/login`);
  await first.close();
  idp.ageSignIn(600);
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(`${base}/auth/login?returnTo=/app/privacy`);
  await expect(page.getByRole('heading', { name: 'ความเป็นส่วนตัว' })).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'ดาวน์โหลดข้อมูลของฉัน' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^tunedeck-export-\d{4}-\d{2}-\d{2}\.json$/);
  const exported = JSON.parse(await (await import('node:fs/promises')).readFile((await download.path())!, 'utf8'));
  expect(exported.devices.map((d: { id: string }) => d.id)).toEqual([device]);

  await page.getByRole('button', { name: 'ลบบัญชีนี้' }).click();
  const yes = page.getByRole('button', { name: 'ยืนยัน ลบบัญชี' });
  await expect(yes).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'ฉันเข้าใจว่าลบแล้วกู้คืนไม่ได้' })).toBeFocused();
  await page.keyboard.press('Space');
  if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/delete-confirm.png`, fullPage: true });
  await yes.click();

  const alert = page.getByRole('alert').filter({ hasText: 'ยืนยันตัวตน' });
  await expect(alert).toContainText('ก่อนลบบัญชี');
  await alert.getByRole('link', { name: 'ยืนยันตัวตน' }).click();
  await expect(page).toHaveURL(`${base}/app/privacy`);
  await page.getByRole('checkbox', { name: 'ฉันเข้าใจว่าลบแล้วกู้คืนไม่ได้' }).check();
  await page.getByRole('button', { name: 'ยืนยัน ลบบัญชี' }).click();

  await expect(page).toHaveURL(new RegExp(`${base}/account-deleted\\?lang=th#[A-Za-z0-9_-]{43}$`));
  await expect(page.getByTestId('deletion-status')).toContainText('ลบข้อมูลของบัญชีเสร็จแล้วเมื่อ');
  if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/delete-done.png`, fullPage: true });
  expect(await context.cookies()).toEqual([]);
  expect((await checkIn()).status).toBe(403);
  await page.goto(`${base}/app/privacy`);
  await expect(page).toHaveURL(/\/login/);
});

test('the overview shows each phone’s last sync, and favorites picked on the web reach the phone', async ({ browser }) => {
  const token = await idp.accessTokenFor('e2e-frank');
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const phone = crypto.randomUUID();
  expect((await fetch(`${api.url}/v1/me/devices/${phone}`, { method: 'PUT', headers: auth, body: JSON.stringify({ platform: 'ios', osMajor: 18, appBuild: '1.0.0+42', appliedSettingsRevision: 0 }) })).status).toBe(200);
  const me = (await (await fetch(`${api.url}/v1/me`, { headers: auth })).json()) as { userId: string };
  for (const [name, genre] of [['Bangkok Jazz', 'jazz'], ['Chiang Mai News', 'news'], ['Phuket Beach FM', 'pop']]) {
    const draft = { name, country: 'TH', language: 'th', genres: [genre], streamUrl: 'https://radio.test/live', codec: 'aac', bitrateKbps: 64 };
    // Test constants only (no quotes in them), so inlining them into the SQL is safe here.
    const d = `'${JSON.stringify(draft)}'::jsonb`;
    const u = `'${me.userId}'::uuid`;
    await stack.api.sql(`INSERT INTO radio_stations (draft, created_by, updated_by, published, published_revision, published_by, published_at) VALUES (${d}, ${u}, ${u}, ${d}, 1, ${u}, now())`);
  }

  idp.setUser('e2e-frank');
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${base}/auth/login?returnTo=/app/overview`);
  await expect(page.getByRole('heading', { name: 'ภาพรวม', exact: true })).toBeVisible();
  await expect(page.getByTestId('service')).toContainText('ระบบทำงานปกติ');
  await expect(page.getByTestId('overview-device')).toContainText('ยังไม่เคยซิงก์');
  await expect(page.getByText('สถานีโปรด 0 สถานี')).toBeVisible();
  // No checkout on the web: Pro shows per store, bought in the phone app.
  await expect(page.getByTestId('pro-store')).toHaveText(['App Store (iPhone)ยังไม่ได้ซื้อ', 'Google Play (Android)ยังไม่ได้ซื้อ']);

  await page.getByRole('link', { name: 'วิทยุ' }).click();
  await expect(page).toHaveURL(`${base}/app/radio`);
  await expect(page.getByTestId('station')).toHaveCount(3);
  // The stream address stays on the server.
  expect(await page.content()).not.toContain('radio.test');
  await page.getByRole('button', { name: 'เพิ่ม Chiang Mai News ในสถานีโปรด' }).click();
  await expect(page.getByTestId('favorite')).toHaveText(['Chiang Mai News↑↓★']);
  await page.getByRole('button', { name: 'เพิ่ม Bangkok Jazz ในสถานีโปรด' }).click();
  await expect(page.getByTestId('favorite')).toHaveCount(2);
  await page.getByRole('button', { name: 'เลื่อน Bangkok Jazz ขึ้น' }).click();
  await expect(page.getByTestId('favorite').first()).toContainText('Bangkok Jazz');
  if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/radio.png`, fullPage: true });

  // The phone pulls the same list and order.
  const pulled = (await (await fetch(`${api.url}/v1/sync/pull?deviceId=${phone}`, { headers: auth })).json()) as { changes: { value: { stationId: string; order: number } | null }[] };
  const live = pulled.changes.filter((c) => c.value).sort((a, b) => a.value!.order - b.value!.order);
  expect(live).toHaveLength(2);

  // A change from the phone meanwhile makes the web's next edit a conflict, and the page reloads the list.
  const favs = (await (await fetch(`${api.url}/v1/me/favorites`, { headers: auth })).json()) as { favorites: { entityId: string; revision: number; stationId: string }[] };
  const jazz = favs.favorites[0];
  const phoneEdit = await fetch(`${api.url}/v1/sync/push`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ deviceId: phone, changes: [{ changeId: crypto.randomUUID(), entityId: jazz.entityId, type: 'favorite', op: 'upsert', baseRevision: jazz.revision, value: { stationId: jazz.stationId, order: 50 } }] }),
  });
  expect(phoneEdit.status).toBe(200);
  await page.getByRole('button', { name: 'เอา Bangkok Jazz ออกจากสถานีโปรด' }).first().click();
  await expect(page.locator('.notice.error')).toContainText('รายการโปรดเปลี่ยนจากอุปกรณ์อื่น');
  await expect(page.getByTestId('favorite').first()).toContainText('Chiang Mai News');
  await page.getByRole('button', { name: 'เอา Bangkok Jazz ออกจากสถานีโปรด' }).first().click();
  await expect(page.getByTestId('favorite')).toHaveCount(1);

  await page.getByRole('link', { name: 'ภาพรวม' }).click();
  await expect(page.getByTestId('overview-device')).toContainText('ซิงก์ล่าสุด');
  await expect(page.getByText('สถานีโปรด 1 สถานี')).toBeVisible();
  if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/overview.png`, fullPage: true });
});
