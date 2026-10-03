import { Browser, expect, Page, test } from '@playwright/test';
import { startStack, Stack } from './stack';

let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack();
  stack.api.staff('grant', 'e2e-editor', 'catalog_editor', '--by', 'e2e', '--reason', 'test');
  stack.api.staff('grant', 'e2e-admin', 'admin', '--by', 'e2e', '--reason', 'test');
});

test.afterAll(async () => {
  await stack?.stop();
});

async function signInAs(browser: Browser, user: string, path = '/admin/stations'): Promise<Page> {
  stack.idp.setUser(user);
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  await page.goto(`${stack.base}/auth/login?returnTo=${encodeURIComponent(path)}`);
  await expect(page).toHaveURL(`${stack.base}${path}`);
  return page;
}

const SHOTS = process.env.ADMIN_SHOTS_DIR;

test('an editor drafts a station and a different admin publishes it', async ({ browser }) => {
  const editor = await signInAs(browser, 'e2e-editor');
  await expect(editor.getByRole('heading', { name: 'รายการสถานี' })).toBeVisible();
  await editor.getByRole('link', { name: '+ เพิ่มสถานี' }).click();
  // The Minimal dashboard has its own quick-add form with the same labels, so wait for the full editor.
  await expect(editor.getByRole('heading', { name: 'เพิ่มสถานี', exact: true })).toBeVisible();
  await editor.getByLabel('ชื่อสถานี').fill('Bangkok Jazz 24');
  await editor.getByLabel('แนวเพลง').fill('jazz');
  await editor.getByLabel('ลิงก์สตรีม').fill('https://10.0.0.1/live.mp3');
  await editor.getByLabel('ที่มาของสิทธิ์').selectOption('owner_permission');
  await editor.getByLabel('เลขอ้างอิงหลักฐาน').fill('CONTRACT-2026-014');
  await editor.getByRole('button', { name: 'สร้างร่าง' }).click();
  // The API's URL rule shows up next to the field, in Thai.
  await expect(editor.locator('.adm-alert')).toContainText('ใช้ชื่อโดเมน ห้ามใช้เลข IP');
  await editor.getByLabel('ลิงก์สตรีม').fill('https://stream.example.com/jazz.mp3');
  await editor.getByRole('button', { name: 'สร้างร่าง' }).click();
  await expect(editor).toHaveURL(/\/admin\/stations\/[0-9a-f-]{36}$/);
  await expect(editor.getByText('ร่าง revision 1')).toBeVisible();
  await expect(editor.getByText('ต้องเป็นแอดมินจึงจะเผยแพร่ได้')).toBeVisible();
  await expect(editor.getByText('คุณแก้ร่างนี้เอง')).toBeVisible();
  const stationUrl = editor.url();

  const admin = await signInAs(browser, 'e2e-admin', new URL(stationUrl).pathname);
  await admin.getByLabel('เหตุผลที่เผยแพร่ (บันทึกใน audit)').fill('ตรวจสัญญาแล้ว');
  await admin.getByRole('button', { name: 'เผยแพร่ revision 1' }).click();
  await expect(admin.getByText('เผยแพร่ revision 1 แล้ว')).toBeVisible();

  const catalog = await (await fetch(`${stack.api.url}/v1/catalog/radio`)).json();
  expect(catalog.stations.map((s: { name: string }) => s.name)).toEqual(['Bangkok Jazz 24']);

  // The admin edits it; the editor's earlier tab is now stale and gets the conflict notice.
  await admin.getByLabel('บิตเรต (kbps)').fill('128');
  await admin.getByRole('button', { name: 'บันทึกร่าง' }).click();
  await expect(admin.getByText('บันทึกร่างแล้ว · revision 2')).toBeVisible();
  await editor.getByLabel('ชื่อสถานี').fill('Bangkok Jazz 24/7');
  await editor.getByRole('button', { name: 'บันทึกร่าง' }).click();
  await expect(editor.locator('.adm-alert')).toContainText('มีคนแก้สถานีนี้ไปก่อนแล้ว');

  // Disabling hides it from the apps.
  await admin.getByLabel('เหตุผลที่ปิด (บันทึกใน audit)').fill('สตรีมล่ม');
  await admin.getByRole('button', { name: 'ปิดสถานี' }).click();
  await expect(admin.getByText('ปิดสถานีแล้ว')).toBeVisible();
  expect((await (await fetch(`${stack.api.url}/v1/catalog/radio`)).json()).stations).toEqual([]);
});

/** A handful of stations in different states, written straight to the API as the editor and the admin. */
async function seed() {
  const call = async (user: string, path: string, method: string, body: object, ifMatch?: number) => {
    const res = await fetch(`${stack.api.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await stack.idp.accessTokenFor(user)}`,
        'content-type': 'application/json',
        ...(ifMatch ? { 'if-match': `"${ifMatch}"` } : {}),
      },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  const rows: [string, string, string, string, string | null, 'publish' | 'draft' | 'disable' | 'change'][] = [
    ['Lukthung Online', 'th', 'TH', 'lukthung', '2027-04-30', 'change'],
    ['News Hour TH', 'th', 'TH', 'news', '2026-10-20', 'publish'],
    ['Lo-fi Drive Radio', 'en', 'JP', 'lofi', '2027-03-15', 'disable'],
    ['Andaman Chill', 'en', 'TH', 'chill', null, 'publish'],
    ['Isan Morlam Live', 'th', 'TH', 'morlam', '2028-04-20', 'draft'],
    ['Chiang Mai Folk FM', 'th', 'TH', 'folk', null, 'draft'],
  ];
  for (const [name, language, country, genre, expires, state] of rows) {
    const s = await call('e2e-editor', '/v1/admin/stations', 'POST', {
      name, language, country, genres: [genre], codec: 'aac', bitrateKbps: 96,
      streamUrl: `https://stream.example.com/${genre}.aac`,
      rightsBasis: state === 'draft' && !expires ? null : 'broadcaster_terms',
      rightsReference: state === 'draft' && !expires ? null : `REF-${genre.toUpperCase()}`,
      rightsExpiresAt: expires,
    });
    if (state === 'draft') continue;
    await call('e2e-admin', `/v1/admin/stations/${s.id}/publish`, 'POST', { reason: 'seed' }, 1);
    if (state === 'disable') await call('e2e-admin', `/v1/admin/stations/${s.id}/disable`, 'POST', { reason: 'seed' });
    if (state === 'change') await call('e2e-editor', `/v1/admin/stations/${s.id}`, 'PATCH', { bitrateKbps: 192 }, 1);
  }
}

test('each theme has its own layout and the choice sticks', async ({ browser }) => {
  await seed();
  const page = await signInAs(browser, 'e2e-admin');
  const picker = page.getByLabel('เลือกธีมหน้าทีมงาน');
  const layouts: Record<string, string> = {
    minimal: '.t-minimal .fv-side + .fv-main .fv-grid',
    'control-room': '.t-control-room .side + .main table',
    'broadcast-rack': '.t-broadcast-rack .bar .vfd',
    'daylight-bento': '.t-daylight-bento .stgrid .art',
    workbench: '.t-workbench .rail + .wb .split .list',
  };
  for (const [theme, selector] of Object.entries(layouts)) {
    await picker.selectOption(theme);
    await expect(page.locator(selector).first()).toBeVisible();
    await page.reload();
    await expect(page.locator(selector).first()).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/list-${theme}.png`, fullPage: true });
    await page.getByRole('link', { name: 'Lukthung Online' }).first().click();
    await expect(page.getByRole('heading', { name: 'Lukthung Online' })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/edit-${theme}.png`, fullPage: true });
    await page.goto(`${stack.base}/admin/stations`);
  }
  // Minimal has its own light/dark switch, remembered in a cookie.
  await picker.selectOption('minimal');
  await page.getByRole('button', { name: 'Dark' }).click();
  await page.reload();
  await expect(page.locator('.t-minimal[data-mode="dark"] .fv-grid')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/list-minimal-dark.png`, fullPage: true });
  await page.getByRole('button', { name: 'Light' }).click();
  // Workbench keyboard: j moves the cursor, Enter opens.
  await picker.selectOption('workbench');
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/admin\/stations\/[0-9a-f-]{36}$/);
});

test('accounts without a staff role see a plain refusal, and signed-out visitors go to sign-in', async ({ browser }) => {
  const page = await signInAs(browser, 'e2e-customer');
  await expect(page.getByRole('heading', { name: 'บัญชีนี้ไม่มีสิทธิ์เข้าหน้าทีมงาน' })).toBeVisible();
  const res = await page.request.get(`${stack.base}/bff/admin/stations`);
  expect(res.status()).toBe(403);

  const anon = await (await browser.newContext()).newPage();
  await anon.goto(`${stack.base}/admin/stations`);
  await expect(anon).toHaveURL(/\/login\?returnTo=%2Fadmin%2Fstations|\/login\?returnTo=\/admin\/stations/);
});
