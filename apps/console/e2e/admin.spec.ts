import { Browser, expect, Page, test } from '@playwright/test';
import { startStack, Stack } from './stack';

let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack();
  stack.api.staff('grant', 'e2e-editor', 'catalog_editor', '--by', 'e2e', '--reason', 'test');
  stack.api.staff('grant', 'e2e-admin', 'admin', '--by', 'e2e', '--reason', 'test');
  stack.api.staff('grant', 'e2e-ops', 'operator', '--by', 'e2e', '--reason', 'test');
  stack.api.staff('grant', 'e2e-auditor', 'auditor', '--by', 'e2e', '--reason', 'test');
  stack.api.staff('grant', 'e2e-support', 'support', '--by', 'e2e', '--reason', 'test');
  stack.api.staff('grant', 'e2e-admin2', 'admin', '--by', 'e2e', '--reason', 'test');
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

test('operators search redacted API logs; editors cannot', async ({ browser }) => {
  const ops = await signInAs(browser, 'e2e-ops', '/admin/logs');
  // Operators have no catalog role, so the menu offers no station page and /admin lands on the overview.
  await expect(ops.getByRole('link', { name: 'สถานีวิทยุ' })).toHaveCount(0);
  await ops.goto(`${stack.base}/admin`);
  await expect(ops).toHaveURL(`${stack.base}/admin/overview`);
  await ops.goto(`${stack.base}/admin/logs`);
  await expect(ops.getByRole('heading', { name: 'บันทึกระบบ' })).toBeVisible();

  // Make a failing request with a known requestId and a secret in the URL, then find it.
  const secret = 'tok_SHOULD_NOT_APPEAR';
  const probe = await ops.request.get(`${stack.api.url}/v1/me/settings?access_token=${secret}`, { headers: { 'x-request-id': 'req-e2e-trace-01' } });
  expect(probe.status()).toBe(401);
  await expect(async () => {
    await ops.goto(`${stack.base}/admin/logs?requestId=req-e2e-trace-01`);
    await expect(ops.locator('.lg-table tbody tr')).toHaveCount(1, { timeout: 500 });
  }).toPass({ timeout: 10_000 });
  const row = ops.locator('.lg-table tbody tr').first();
  await expect(row).toContainText('WARN');
  await expect(row).toContainText('401');
  await expect(ops.locator('body')).not.toContainText(secret);

  // Filters go through the form; a bad value gets a plain message, not a crash.
  await ops.goto(`${stack.base}/admin/logs`);
  await ops.getByLabel('HTTP status').fill('abc');
  await ops.getByRole('button', { name: 'ค้นหา' }).click();
  await expect(ops.locator('.adm-alert')).toContainText('HTTP status');
  await ops.getByLabel('HTTP status').fill('401');
  await ops.getByLabel('ระดับ').selectOption('warn');
  await ops.getByRole('button', { name: 'ค้นหา' }).click();
  await expect(ops.locator('.lg-table tbody tr').first()).toContainText('401');
  if (SHOTS) await ops.screenshot({ path: `${SHOTS}/logs-minimal.png`, fullPage: true });

  const editor = await signInAs(browser, 'e2e-editor');
  await expect(editor.getByRole('link', { name: 'บันทึกระบบ' })).toHaveCount(0);
  await editor.goto(`${stack.base}/admin/logs`);
  await expect(editor.locator('.adm-alert')).toContainText('ไม่มีสิทธิ์ดูบันทึกระบบ');
});

test('the log page has its own layout in each theme', async ({ browser }) => {
  const page = await signInAs(browser, 'e2e-admin', '/admin/logs');
  const picker = page.getByLabel('เลือกธีมหน้าทีมงาน');
  const layouts: Record<string, string> = {
    'control-room': '.t-control-room .cr-page .cr-filter + .lg-pn table',
    'broadcast-rack': '.t-broadcast-rack .br-tape li',
    'daylight-bento': '.t-daylight-bento .db-stats + .db-filter',
    workbench: '.t-workbench .split .lg-it',
    minimal: '.t-minimal .fv-logstats + .fv-card .fv-logform',
  };
  for (const [theme, selector] of Object.entries(layouts)) {
    await picker.selectOption(theme);
    await expect(page.locator(selector).first()).toBeVisible();
    if (theme === 'workbench') {
      // j moves to the next line and the detail pane follows.
      const second = await page.locator('.lg-it').nth(1).locator('small').innerText();
      await page.locator('body').click({ position: { x: 900, y: 600 } });
      await page.keyboard.press('j');
      await expect(page.locator('.lg-it.sel small')).toHaveText(second);
      await expect(page.locator('.lg-fields')).toBeVisible();
    }
    await expect(page.getByRole('link', { name: 'บันทึกระบบ' }).first()).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/logs-${theme}.png`, fullPage: true });
  }
});

test('auditors read who changed what; reading is recorded', async ({ browser }) => {
  const aud = await signInAs(browser, 'e2e-auditor', '/admin/audit');
  await aud.goto(`${stack.base}/admin`);
  await expect(aud).toHaveURL(`${stack.base}/admin/audit`);
  await expect(aud.getByRole('link', { name: 'บันทึกระบบ' })).toHaveCount(0);
  const feed = aud.locator('.au-feed li');
  // Role grants from the operator CLI are always there; station work from earlier tests too.
  await expect(aud.locator('.au-feed')).toContainText('ให้สิทธิ์ทีมงาน');
  await expect(aud.locator('.au-feed')).toContainText('เผยแพร่สถานี');
  await expect(aud.locator('.au-feed')).not.toContainText('ดูประวัติการแก้ไข');
  if (SHOTS) await aud.screenshot({ path: `${SHOTS}/audit-minimal.png`, fullPage: true });

  // Clicking an actor narrows the list to that actor.
  await aud.locator('.au-feed').getByRole('link', { name: 'e2e-admin' }).first().click();
  await expect(aud).toHaveURL(/actor=e2e-admin/);
  for (const text of await feed.locator('.fv-tx-side b').allInnerTexts()) expect(text).toBe('e2e-admin');

  // Including reads shows this auditor's own views.
  await aud.goto(`${stack.base}/admin/audit?family=audit&reads=1`);
  await expect(aud.locator('.au-feed')).toContainText('ดูประวัติการแก้ไข');
  await expect(aud.locator('.au-feed')).toContainText('e2e-auditor');

  const editor = await signInAs(browser, 'e2e-editor');
  await expect(editor.getByRole('link', { name: 'ประวัติการแก้ไข' })).toHaveCount(0);
  await editor.goto(`${stack.base}/admin/audit`);
  await expect(editor.locator('.adm-alert')).toContainText('ไม่มีสิทธิ์ดูประวัติการแก้ไข');
});

test('the audit page has its own layout in each theme', async ({ browser }) => {
  const page = await signInAs(browser, 'e2e-admin', '/admin/audit');
  const picker = page.getByLabel('เลือกธีมหน้าทีมงาน');
  const layouts: Record<string, string> = {
    'control-room': '.t-control-room .audit .cr-filter + .lg-pn table',
    'broadcast-rack': '.t-broadcast-rack .br-book li',
    'daylight-bento': '.t-daylight-bento .db-days h4',
    workbench: '.t-workbench .split .au-it',
    minimal: '.t-minimal .fv-logstats + .fv-card .fv-logform',
  };
  for (const [theme, selector] of Object.entries(layouts)) {
    await picker.selectOption(theme);
    await expect(page.locator(selector).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'ประวัติการแก้ไข' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'ส่งออก CSV' })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/audit-${theme}.png`, fullPage: true });
  }

  // Export the current search with a reason; the export lands in the trail with that reason.
  await page.getByRole('button', { name: 'ส่งออก CSV' }).click();
  const reason = page.getByLabel('เหตุผลในการส่งออก (จะถูกบันทึกไว้)');
  await expect(reason).toBeFocused();
  await expect(page.getByRole('button', { name: 'ดาวน์โหลด CSV' })).toBeDisabled();
  await reason.fill('ตรวจสอบรายไตรมาสให้เจ้าของ');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/audit-export.png`, fullPage: true });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'ดาวน์โหลด CSV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^tunedeck-audit-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await (await import('node:fs/promises')).readFile((await download.path())!, 'utf8');
  expect(csv.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe('id,occurredAt,actor,actorSubject,action,targetType,targetId,targetLabel,reason,changes,requestId');
  await expect(page.getByRole('status').filter({ hasText: 'ถูกบันทึกพร้อมเหตุผล' })).toBeVisible();
  const logged = (await stack.api.sql(`SELECT reason FROM audit_events WHERE action = 'audit.export'`)) as { rows: { reason: string }[] };
  expect(logged.rows.map((r) => r.reason)).toEqual(['ตรวจสอบรายไตรมาสให้เจ้าของ']);
});

/** Scheduled check results, as the API's checker would write them (it is off in tests). */
async function seedHealth() {
  const rows = (name: string, n: number, status: 'ok' | 'fail', reason: string, http: number | null, latency: number | null) =>
    `INSERT INTO station_health (station_id, check_region, checked_at, status, reason, http_status, latency_ms)
     SELECT id, 'asia-southeast', now() - make_interval(mins => g * 15), '${status}', '${reason}', ${http ?? 'NULL'}, ${latency ?? 'NULL'}
       FROM radio_stations, generate_series(0, ${n - 1}) g WHERE draft->>'name' = '${name}';`;
  // Health counts only checks since the last publish, so place the publishes before the seeded checks.
  await stack.api.sql(
    `UPDATE radio_stations SET published_at = now() - interval '1 day' WHERE published_at IS NOT NULL;` +
    rows('News Hour TH', 2, 'ok', 'ok', 200, 184) +
      rows('Andaman Chill', 3, 'fail', 'timeout', null, 10000) +
      rows('Lukthung Online', 1, 'fail', 'http_status', 503, 92),
  );
}

test('stream health shows in every theme, and staff can check a stream now', async ({ browser }) => {
  await seedHealth();
  const page = await signInAs(browser, 'e2e-editor');
  const picker = page.getByLabel('เลือกธีมหน้าทีมงาน');
  const markers: Record<string, string> = {
    minimal: '.t-minimal .fv-rows .hl-line.suspect',
    'control-room': '.t-control-room table .tag.hl-suspect',
    'broadcast-rack': '.t-broadcast-rack .pre .hl-sig.suspect',
    'daylight-bento': '.t-daylight-bento .st .hl-chip.suspect',
    workbench: '.t-workbench .list .hl-line.suspect',
  };
  for (const [theme, selector] of Object.entries(markers)) {
    await picker.selectOption(theme);
    await expect(page.locator(selector).first()).toBeVisible();
    await expect(page.locator(selector).first()).toContainText('น่าสงสัย');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/health-list-${theme}.png`, fullPage: true });
  }
  await picker.selectOption('minimal');
  await expect(page.getByRole('region', { name: 'สตรีมที่ต้องดู' })).toContainText('Andaman Chill');

  // The station page explains a suspect stream and does not disable it.
  await page.getByRole('link', { name: 'Andaman Chill' }).first().click();
  const panel = page.getByRole('region', { name: 'สุขภาพสตรีม' });
  await expect(panel.locator('.hl-pill')).toHaveText('น่าสงสัย');
  await expect(panel).toContainText('ไม่ผ่าน 3 ครั้งติด');
  await expect(panel).toContainText('ระบบไม่ปิดสถานีเอง');
  await expect(page.getByText('เผยแพร่แล้ว').first()).toBeVisible();
  await panel.getByText('ประวัติการตรวจ 3 ครั้งล่าสุด').click();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/health-station-minimal.png`, fullPage: true });

  // Check now: the real probe runs against the published URL, so the outcome depends on the network.
  await panel.getByRole('button', { name: 'ตรวจตอนนี้' }).click();
  await expect(panel.getByRole('status')).toHaveText(/เล่นได้|ตรวจไม่ผ่าน/, { timeout: 15_000 });
  await expect(panel).toContainText('ประวัติการตรวจ 4 ครั้งล่าสุด');
  await panel.getByRole('button', { name: 'ตรวจตอนนี้' }).click();
  await expect(panel.getByRole('status')).toHaveText('เพิ่งตรวจไปไม่ถึงนาที รอสักครู่แล้วลองใหม่');
});

test('operators see the overview in every theme; editors cannot', async ({ browser }) => {
  const page = await signInAs(browser, 'e2e-ops', '/admin/overview');
  // Every request so far went through the API's own logger (flushed to the database each second).
  await expect(async () => {
    await page.reload();
    await expect(page.locator('.ov-chart svg rect.ok').first()).toBeAttached({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
  await expect(page.locator('.ov-chart table tbody tr')).toHaveCount(24);
  await page.getByRole('link', { name: '1 ชั่วโมง' }).first().click();
  await expect(page).toHaveURL(`${stack.base}/admin/overview?window=1h`);
  await expect(page.locator('.ov-chart table tbody tr')).toHaveCount(12);

  const picker = page.getByLabel('เลือกธีมหน้าทีมงาน');
  const layouts: Record<string, string> = {
    'control-room': '.t-control-room .cr-page .ov-kpis + .ov-grid .ov-chart',
    'broadcast-rack': '.t-broadcast-rack .ov-lamps + .ov-meters [role=meter]',
    'daylight-bento': '.t-daylight-bento .ov-bento .b-chart .ov-chart',
    workbench: '.t-workbench .split .ov-it',
    minimal: '.t-minimal .fv-logstats + .fv-card .ov-chart',
  };
  for (const [theme, selector] of Object.entries(layouts)) {
    await picker.selectOption(theme);
    await expect(page.locator(selector).first()).toBeVisible();
    if (theme === 'workbench') await page.locator('.ov-it .lg-pick', { hasText: 'คำขอ API' }).click();
    // Hovering a bar shows its numbers.
    await page.locator('.ov-chart svg g').last().hover();
    await expect(page.locator('.ov-tip')).toContainText('คำขอ');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/overview-${theme}.png`, fullPage: true });
    if (theme === 'workbench') {
      await page.locator('.ov-it .lg-pick', { hasText: 'สุขภาพสถานี' }).click();
      await expect(page.locator('.det .ov-dl dt', { hasText: 'น่าสงสัย' })).toBeVisible();
    }
  }

  const editor = await signInAs(browser, 'e2e-editor');
  await expect(editor.getByRole('link', { name: 'ภาพรวมระบบ' })).toHaveCount(0);
  await editor.goto(`${stack.base}/admin/overview`);
  await expect(editor.locator('.adm-alert')).toContainText('ไม่มีสิทธิ์ดูภาพรวมระบบ');
});

test('operators retry a failed account deletion with a reason, in every theme', async ({ browser }) => {
  // A deletion whose last background attempt failed five minutes ago (the purge itself works in tests).
  await stack.api.sql(
    `WITH u AS (INSERT INTO users (oidc_subject, status) VALUES ('e2e-jobs-leaver', 'deleting') RETURNING id)
     INSERT INTO account_deletions (ticket_hash, user_id, subject_hash, status, attempts, last_attempt_at, requested_at)
     SELECT repeat('ab', 32), id, 's-e2e', 'failed', 3, now() - interval '5 minutes', now() - interval '2 days' FROM u`,
  );
  const page = await signInAs(browser, 'e2e-ops', '/admin/jobs');
  const picker = page.getByLabel('เลือกธีมหน้าทีมงาน');
  const layouts: Record<string, string> = {
    'control-room': '.t-control-room .cr-page .jb-kpis + .pn .jb-table',
    'broadcast-rack': '.t-broadcast-rack .jb-rack li.jb-failed',
    'daylight-bento': '.t-daylight-bento .jb-bento .b-job',
    workbench: '.t-workbench .split .jb-it.sel',
    minimal: '.t-minimal .fv-logstats + .fv-card .jb-list',
  };
  for (const [theme, selector] of Object.entries(layouts)) {
    await picker.selectOption(theme);
    await expect(page.locator(selector).first()).toBeVisible();
    await expect(page.getByText('ไม่สำเร็จ กำลังลองใหม่อัตโนมัติ').first()).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/jobs-${theme}.png`, fullPage: true });
  }

  await picker.selectOption('minimal');
  await page.getByRole('button', { name: 'ลองใหม่ตอนนี้' }).click();
  await page.getByLabel('เหตุผล (จะถูกบันทึกไว้ในประวัติ)').fill('ลองใหม่หลังแก้ฐานข้อมูลแล้ว');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/jobs-retry.png`, fullPage: true });
  await page.getByRole('button', { name: 'ลองใหม่', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'ลบข้อมูลบัญชีเสร็จแล้ว' })).toBeVisible();
  await expect(page.locator('.jb-empty')).toHaveText('ไม่มีงานค้าง');
  const logged = (await stack.api.sql(`SELECT reason, changes->>'result' AS result FROM audit_events WHERE action = 'job.retry'`)) as { rows: { reason: string; result: string }[] };
  expect(logged.rows).toEqual([{ reason: 'ลองใหม่หลังแก้ฐานข้อมูลแล้ว', result: 'completed' }]);

  const editor = await signInAs(browser, 'e2e-editor');
  await expect(editor.getByRole('link', { name: 'งานเบื้องหลัง' })).toHaveCount(0);
  await editor.goto(`${stack.base}/admin/jobs`);
  await expect(editor.locator('.adm-alert')).toContainText('ไม่มีสิทธิ์ดูงานเบื้องหลัง');
});

test('support looks up a customer by email or device id with a reason, in every theme', async ({ browser }) => {
  // A customer whose tablet has not picked up the latest settings yet.
  await stack.api.sql(
    `WITH u AS (INSERT INTO users (id, oidc_subject, email, email_verified) VALUES ('6f1d2c3b-0000-4000-8000-00000000c0de', 'e2e-support-case', 'nok@example.test', true) RETURNING id),
          p AS (INSERT INTO account_preferences (owner_id, schema_version, revision, value) SELECT id, 1, 3, '{}' FROM u)
     INSERT INTO devices (user_id, id, platform, os_major, app_build, applied_settings_revision, last_seen_at)
     SELECT u.id, d.id::uuid, d.platform, d.os, d.build, d.rev, now() - d.ago FROM u,
       (VALUES ('11111111-2222-4333-8444-555555555555', 'ios', 18, '1.0.0+42', 3, interval '5 minutes'),
               ('99999999-8888-4777-8666-555555555555', 'android', 14, '1.0.0+40', 1, interval '3 days')) d(id, platform, os, build, rev, ago)`,
  );
  const page = await signInAs(browser, 'e2e-support', '/admin/users');
  await expect(page.getByRole('link', { name: 'บันทึกระบบ' })).toHaveCount(0);
  await page.goto(`${stack.base}/admin`);
  await expect(page).toHaveURL(`${stack.base}/admin/users`);

  const picker = page.getByLabel('เลือกธีมหน้าทีมงาน');
  const layouts: Record<string, string> = {
    'control-room': '.t-control-room .cr-page .us-kpis + .ov-grid .us-table',
    'broadcast-rack': '.t-broadcast-rack .ov-lamps + .us-rack li',
    'daylight-bento': '.t-daylight-bento .us-bento .b-device',
    workbench: '.t-workbench .split .us-it.sel',
    minimal: '.t-minimal .fv-logstats + .fv-card .us-table',
  };
  for (const [theme, selector] of Object.entries(layouts)) {
    await picker.selectOption(theme);
    await page.getByLabel('อีเมล รหัสผู้ใช้ หรือรหัสเครื่อง').fill(theme === 'minimal' ? 'NOK@example.test' : '99999999-8888-4777-8666-555555555555');
    await page.getByLabel('เหตุผล (จะถูกบันทึกไว้ในประวัติ)').fill('ลูกค้าแจ้งว่าแท็บเล็ตไม่ได้ธีมใหม่');
    await page.getByRole('button', { name: 'ค้นหา' }).click();
    await expect(page.locator(selector).first()).toBeVisible();
    if (theme !== 'workbench') await expect(page.getByText('ยังไม่ได้รับการตั้งค่าล่าสุด (ใช้ r1 จาก r3)').first()).toBeVisible();
    await expect(page.getByText('nok@example.test').first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText('e2e-support-case');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/users-${theme}.png`, fullPage: true });
  }
  await page.getByLabel('อีเมล รหัสผู้ใช้ หรือรหัสเครื่อง').fill('00000000-0000-4000-8000-000000000000');
  await page.getByRole('button', { name: 'ค้นหา' }).click();
  await expect(page.locator('.us-problem')).toContainText('ไม่พบบัญชี');

  const logged = (await stack.api.sql(`SELECT target_id, changes->>'found' AS found FROM audit_events WHERE action = 'user.lookup' ORDER BY id`)) as { rows: { target_id: string; found: string }[] };
  expect(logged.rows).toHaveLength(6);
  expect(logged.rows.at(-1)).toEqual({ target_id: 'none', found: 'false' });

  const ops = await signInAs(browser, 'e2e-ops', '/admin/overview');
  await expect(ops.getByRole('link', { name: 'ผู้ใช้' })).toHaveCount(0);
  await ops.goto(`${stack.base}/admin/users`);
  await expect(ops.locator('.adm-alert')).toContainText('ไม่มีสิทธิ์ดูข้อมูลผู้ใช้');
});

test('an admin drafts the app config, a second admin publishes it signed, in every theme', async ({ browser }) => {
  const author = await signInAs(browser, 'e2e-admin', '/admin/config');
  await expect(author.getByText('ยังไม่เคยเผยแพร่ แอปใช้ค่าเริ่มต้นของแอปเอง').first()).toBeVisible();
  await author.getByLabel('build ขั้นต่ำ iOS').fill('42');
  await author.getByLabel('นำเข้าเพลย์ลิสต์ M3U/EPG').uncheck();
  await author.getByRole('button', { name: 'บันทึกร่าง' }).click();
  await expect(author.getByText('บันทึกร่างแล้ว')).toBeVisible();
  await expect(author.getByText('คุณแก้ร่างนี้เอง ต้องให้แอดมินอีกคนตรวจและเผยแพร่')).toBeVisible();
  await expect(author.getByText('build ขั้นต่ำ iOS, นำเข้าเพลย์ลิสต์').first()).toBeVisible();

  const reviewer = await signInAs(browser, 'e2e-admin2', '/admin/config');
  await reviewer.locator('#cf-reason').fill('build 41 ล่มตอนนำเข้า บังคับ 42 และปิดนำเข้าชั่วคราว');
  await reviewer.getByLabel('ใช้ได้นาน').selectOption('14');
  if (SHOTS) await reviewer.screenshot({ path: `${SHOTS}/config-publish.png`, fullPage: true });
  await reviewer.getByRole('button', { name: 'เผยแพร่ร่าง r1' }).click();
  await expect(reviewer.getByText('เผยแพร่แล้ว')).toBeVisible();
  await expect(reviewer.getByText('แอปใช้ รุ่น 1').first()).toBeVisible();

  // What the apps get: release 1, signed (the JWS payload carries the same document).
  const served = await (await fetch(`${stack.api.url}/v1/config`)).json();
  expect(served).toMatchObject({ release: 1, config: { minSupportedBuild: { ios: 42, android: null }, features: { playlistImport: false } } });
  expect(served.jws.split('.')).toHaveLength(3);

  const picker = reviewer.getByLabel('เลือกธีมหน้าทีมงาน');
  const layouts: Record<string, string> = {
    'control-room': '.t-control-room .cr-page.cf .cf-cols .cf-form',
    'broadcast-rack': '.t-broadcast-rack .br-page.cf .cf-rack .cf-form',
    'daylight-bento': '.t-daylight-bento .cf-bento .cf-b-draft .cf-form',
    workbench: '.t-workbench .split .det .cf-form',
    minimal: '.t-minimal .fv-dash.cf .cf-cols .cf-form',
  };
  for (const [theme, selector] of Object.entries(layouts)) {
    await picker.selectOption(theme);
    await expect(reviewer.locator(selector)).toBeVisible();
    await expect(reviewer.getByText('รุ่น 1').first()).toBeVisible();
    if (SHOTS) await reviewer.screenshot({ path: `${SHOTS}/config-${theme}.png`, fullPage: true });
  }

  // Operators can look but not change anything.
  const ops = await signInAs(browser, 'e2e-ops', '/admin/config');
  await expect(ops.getByText('ดูได้อย่างเดียว เฉพาะแอดมินแก้ไขได้')).toBeVisible();
  await expect(ops.getByLabel('build ขั้นต่ำ iOS')).toBeDisabled();
  await expect(ops.getByRole('button', { name: /ย้อนไปใช้รุ่น/ })).toHaveCount(0);
  const editor = await signInAs(browser, 'e2e-editor', '/admin/stations');
  await expect(editor.getByRole('link', { name: 'ตั้งค่าแอป' })).toHaveCount(0);

  const audit = (await stack.api.sql(`SELECT action FROM audit_events WHERE target_type = 'config' ORDER BY id`)) as { rows: { action: string }[] };
  expect(audit.rows.map((r) => r.action)).toEqual(['config.update', 'config.publish']);
});

