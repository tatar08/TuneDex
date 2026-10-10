import { Browser, expect, Page, test } from '@playwright/test';
import { startStack, Stack } from './stack';

// The frame every account page shares (Tar 2026-10-11): staff choose the layout theme for everyone, a visitor
// chooses only a colour, and the home page always has something to play.
let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack();
  stack.api.staff('grant', 'e2e-th-admin', 'admin', '--by', 'e2e', '--reason', 'test');
  stack.api.staff('grant', 'e2e-th-admin2', 'admin', '--by', 'e2e', '--reason', 'test');
  stack.api.staff('grant', 'e2e-th-editor', 'catalog_editor', '--by', 'e2e', '--reason', 'test');
  // Two published stations, so Home has a curated wall. One admin drafts, the other publishes.
  const call = async (who: string, path: string, body: object, headers: Record<string, string> = {}) =>
    fetch(`${stack.api.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${await stack.idp.accessTokenFor(who)}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  for (const [name, genre] of [['Wall Jazz FM', 'jazz'], ['Wall News TH', 'news']]) {
    const made = (await (await call('e2e-th-admin', '/v1/admin/stations', { name, language: 'th', country: 'TH', genres: [genre], codec: 'aac', bitrateKbps: 96, streamUrl: `https://stream.example.com/${genre}.aac` })).json()) as { id: string };
    const rights = await call('e2e-th-admin', `/v1/admin/stations/${made.id}/rights`, { holder: `${name} owner`, basis: 'broadcaster_terms', reference: `REF-${genre.toUpperCase()}`, territories: ['TH'], validFrom: '2026-01-01', expiresAt: '2030-01-01' });
    expect(rights.status, await rights.text()).toBe(201);
    const res = await call('e2e-th-admin2', `/v1/admin/stations/${made.id}/publish`, { reason: 'reviewed for the theme test' }, { 'if-match': '"1"' });
    expect(res.status, await res.text()).toBe(200);
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

async function open(browser: Browser, user: string, path: string): Promise<Page> {
  stack.idp.setUser(user);
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 860 } })).newPage();
  await page.goto(`${stack.base}/auth/login?returnTo=${encodeURIComponent(path)}`);
  await expect(page).toHaveURL(`${stack.base}${path}`);
  return page;
}

test('home has stations to play, and the sound keeps going from page to page', async ({ browser }) => {
  const page = await open(browser, 'e2e-th-user', '/app/home');
  await expect(page.getByRole('heading', { name: 'วิทยุของคุณ' })).toBeVisible();
  // No favourites yet and this stack has no Radio Browser, so the wall falls back from the country's most listened
  // to the curated stations rather than opening on an error.
  await expect(page.getByRole('tab', { name: /คัดสรร/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('wall-station')).toHaveCount(2);
  await expect(page.getByTestId('player')).toHaveCount(0);
  await page.getByRole('button', { name: 'เล่น Wall Jazz FM' }).click();
  const player = page.getByTestId('player');
  await expect(player).toHaveAttribute('aria-label', 'กำลังเล่น: Wall Jazz FM');
  const src = () => page.locator('.player-screen video').evaluate((v: HTMLVideoElement) => v.src);
  expect(await src()).toBe('https://stream.example.com/jazz.aac');
  // The same media element, untouched, on every page: it is tagged here and found again after each move.
  await page.locator('.player-screen video').evaluate((v) => v.setAttribute('data-kept', 'yes'));
  for (const [link, url] of [['การตั้งค่า', '/app/settings'], ['อุปกรณ์', '/app/devices'], ['สำรวจ', '/app/explore'], ['วิทยุ', '/app/radio']]) {
    await page.getByRole('link', { name: link, exact: true }).first().click();
    await expect(page).toHaveURL(`${stack.base}${url}`);
    await expect(player).toContainText('Wall Jazz FM');
    await expect(page.locator('.player-screen video')).toHaveAttribute('data-kept', 'yes');
    expect(await src()).toBe('https://stream.example.com/jazz.aac');
  }
  // What was played is remembered in this browser for the "recently played" tab.
  await page.goto(`${stack.base}/app/home`);
  await page.getByRole('tab', { name: /ฟังล่าสุด/ }).click();
  await expect(page.getByTestId('wall-station')).toHaveText([/Wall Jazz FM/]);
});

test('home opens on the chosen country’s most listened stations, with their logos, and lists my own links', async ({ browser }) => {
  stack.idp.setUser('e2e-th-popular');
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 860 } })).newPage();
  const top = (country: string) =>
    [1, 2, 3].map((n) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, name: `${country} Top ${n}`, country, language: 'thai', genres: n === 1 ? ['pop', 'hits'] : [], codec: 'mp3', bitrateKbps: 128, streamUrl: `https://top${n}.example.test/${country}.mp3`, ...(n === 1 ? { logoVersion: 'abcdefabcdef' } : {}) }));
  const asked: string[] = [];
  await page.route('**/bff/directory/top**', (route) => {
    const country = new URL(route.request().url()).searchParams.get('country')!;
    asked.push(country);
    return route.fulfill({ json: { stations: top(country), attribution: 'Radio Browser' } });
  });
  await page.addInitScript(() => localStorage.setItem('tunedeck.web.channels', JSON.stringify([{ id: 'c1', name: 'My Kept Station', url: 'https://kept.example.test/live.mp3', hls: false, group: 'ไทย' }])));
  await page.goto(`${stack.base}/auth/login?returnTo=/app/home`);
  await expect(page.getByRole('tab', { name: /ยอดนิยมในประเทศ/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('wall-station')).toHaveText([/TH Top 1.*pop, hits/, /TH Top 2/, /TH Top 3/]);
  expect(asked).toEqual(['TH']);
  // A station's own logo when it has one, TuneDeck's otherwise; always from this site.
  await expect(page.getByTestId('wall-station').first().locator('img')).toHaveAttribute('src', '/bff/logos/stations/00000000-0000-4000-8000-000000000001?v=abcdefabcdef');
  await expect(page.getByTestId('wall-station').nth(1).locator('img')).toHaveAttribute('src', '/bff/logos/default');
  // The country is the viewer's choice and is remembered.
  await page.getByLabel('ประเทศ', { exact: true }).selectOption('JP');
  await expect(page.getByTestId('wall-station').first()).toContainText('JP Top 1');
  await page.getByRole('button', { name: 'เล่น JP Top 1' }).click();
  await expect(page.getByTestId('player')).toHaveAttribute('aria-label', 'กำลังเล่น: JP Top 1');
  await page.reload();
  await expect(page.getByLabel('ประเทศ', { exact: true })).toHaveValue('JP');
  await page.getByRole('tab', { name: /ลิงก์ของฉัน/ }).click();
  await expect(page.getByTestId('wall-station')).toHaveText([/My Kept Station.*ไทย/]);
  if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/home-links.png` });
});

test('a visitor chooses only a colour, kept in the browser', async ({ browser }) => {
  const page = await open(browser, 'e2e-th-user2', '/app/settings');
  const frame = page.getByTestId('app-frame');
  await expect(frame).toHaveAttribute('data-accent', 'default');
  await page.getByRole('radio', { name: 'น้ำเงิน' }).check();
  await expect(frame).toHaveAttribute('data-accent', 'blue');
  await page.reload();
  await expect(frame).toHaveAttribute('data-accent', 'blue');
  await expect(page.getByRole('radio', { name: 'น้ำเงิน' })).toBeChecked();
  // Nothing on the page lets a visitor change the layout.
  await expect(page.getByText('ผนังวิทยุส่วนตัว')).toHaveCount(0);
});

test('an admin chooses the layout theme for everyone; editors cannot', async ({ browser }) => {
  const user = await open(browser, 'e2e-th-user3', '/app/home');
  await expect(user.getByTestId('app-frame')).toHaveClass(/t-classic/);
  await expect(user.locator('.shell > .nav')).toBeVisible();
  await expect(user.locator('.side-nav')).toHaveCount(0);

  const editor = await open(browser, 'e2e-th-editor', '/admin/settings');
  await expect(editor.getByRole('heading', { name: 'ธีมของเว็บผู้ใช้' })).toHaveCount(0);

  const admin = await open(browser, 'e2e-th-admin', '/admin/settings');
  const form = admin.getByRole('form', { name: 'ธีมของเว็บผู้ใช้' });
  await expect(form.getByRole('radio', { name: /ดั้งเดิม/ })).toBeChecked();
  await expect(form.getByRole('button', { name: 'ใช้ธีมนี้กับผู้ใช้ทุกคน' })).toBeDisabled();
  await form.getByRole('radio', { name: /ผนังวิทยุส่วนตัว/ }).check();
  await form.getByRole('button', { name: 'ใช้ธีมนี้กับผู้ใช้ทุกคน' }).click();
  await expect(form.getByRole('status')).toContainText('บันทึกแล้ว');
  await expect(form.getByText('เปลี่ยนล่าสุดโดย e2e-th-admin')).toBeVisible();
  if (process.env.ADMIN_SHOTS_DIR) await admin.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/theme-picker.png`, fullPage: true });

  // Everyone gets it: side menu on a wide screen, the pages' own top menu gone, the player a bar along the bottom.
  await user.reload();
  await expect(user.getByTestId('app-frame')).toHaveClass(/t-radio-wall/);
  const side = user.locator('.side-nav');
  await expect(side).toBeVisible();
  await expect(side.getByRole('link', { name: 'หน้าแรก' })).toHaveAttribute('aria-current', 'page');
  await expect(user.locator('.shell > .nav')).toBeHidden();
  await user.getByRole('button', { name: 'เล่น Wall News TH' }).click();
  const bar = await user.locator('.player-dock').boundingBox();
  expect([bar!.x, Math.round(bar!.y + bar!.height), bar!.width]).toEqual([0, 860, 1360]);
  if (process.env.ADMIN_SHOTS_DIR) await user.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/theme-radio-wall-home.png` });
  await side.getByRole('link', { name: 'สำรวจ' }).click();
  await expect(user).toHaveURL(`${stack.base}/app/explore`);
  await expect(user.getByTestId('player')).toContainText('Wall News TH');
  if (process.env.ADMIN_SHOTS_DIR) await user.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/theme-radio-wall-explore.png` });
  await side.getByRole('link', { name: 'การตั้งค่า' }).click();
  await expect(user.getByTestId('player')).toContainText('Wall News TH');
  if (process.env.ADMIN_SHOTS_DIR) await user.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/theme-radio-wall-settings.png` });
  // A phone keeps its one layout whatever the theme.
  await user.setViewportSize({ width: 390, height: 844 });
  await expect(side).toBeHidden();
  await expect(user.locator('.tabbar')).toBeVisible();

  await form.getByRole('radio', { name: /ดั้งเดิม/ }).check();
  await form.getByRole('button', { name: 'ใช้ธีมนี้กับผู้ใช้ทุกคน' }).click();
  await expect(form.getByRole('status')).toContainText('บันทึกแล้ว');
});
