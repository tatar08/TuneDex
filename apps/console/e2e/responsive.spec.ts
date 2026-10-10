import { Browser, expect, Page, test } from '@playwright/test';
import { startStack, Stack } from './stack';

// Phone and tablet sizes (CSS pixels) Tar's users hold: iPhone, iPad portrait and landscape. Every page must fit the
// width without sideways scrolling; RESPONSIVE_SHOTS_DIR keeps a screenshot of each for review.
const DEVICES = {
  iphone: { width: 390, height: 844 },
  'ipad-portrait': { width: 820, height: 1180 },
  'ipad-landscape': { width: 1180, height: 820 },
} as const;
const SHOTS = process.env.RESPONSIVE_SHOTS_DIR;

let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack();
  // One staff member per device: each person gets 120 API reads a minute and every theme reads a page again.
  for (const user of ['e2e-r-admin', ...Object.keys(DEVICES).map((d) => `e2e-r-admin-${d}`)]) stack.api.staff('grant', user, 'admin', '--by', 'e2e', '--reason', 'test');
  // A few stations, so the staff lists have rows to lay out.
  for (const [name, genre] of [['Lukthung Online with a rather long station name', 'lukthung'], ['News Hour TH', 'news'], ['Andaman Chill', 'chill']]) {
    await fetch(`${stack.api.url}/v1/admin/stations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await stack.idp.accessTokenFor('e2e-r-admin')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name, language: 'th', country: 'TH', genres: [genre], codec: 'aac', bitrateKbps: 96, streamUrl: `https://stream.example.com/${genre}.aac` }),
    });
  }
});

test.afterAll(async () => {
  await stack?.stop();
});

async function open(browser: Browser, user: string, device: keyof typeof DEVICES, path: string): Promise<Page> {
  stack.idp.setUser(user);
  const page = await (await browser.newContext({ viewport: DEVICES[device], hasTouch: device !== 'ipad-landscape', isMobile: device === 'iphone' })).newPage();
  await page.goto(`${stack.base}/auth/login?returnTo=${encodeURIComponent(path)}`);
  await expect(page).toHaveURL(`${stack.base}${path}`);
  return page;
}

async function fits(page: Page, name: string) {
  await page.waitForLoadState('load');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(wide, `${name} scrolls sideways by ${wide}px`).toBeLessThanOrEqual(0);
}

const station = (n: number, name: string, lat: number, lon: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  name,
  country: 'TH',
  language: 'thai',
  genres: ['pop'],
  codec: 'mp3',
  bitrateKbps: 128,
  streamUrl: `https://s${n}.example.test/live.mp3`,
  lat,
  lon,
});

for (const device of Object.keys(DEVICES) as (keyof typeof DEVICES)[]) {
  test(`account pages fit a ${device}`, async ({ browser }) => {
    const page = await open(browser, `e2e-r-${device}`, device, '/app/overview');
    for (const path of ['/app/overview', '/app/radio', '/app/settings', '/app/devices', '/app/privacy']) {
      await page.goto(`${stack.base}${path}`);
      await fits(page, `${device}${path.replaceAll('/', '-')}`);
    }
    if (device === 'iphone') {
      // The phone's links sit in a bottom bar; the rest and sign-out open from "More".
      const bar = page.getByRole('navigation', { name: 'เมนูหลัก' });
      await expect(bar.getByRole('link', { name: 'วิทยุ' })).toBeVisible();
      await bar.getByText('เพิ่มเติม').click();
      await expect(bar.getByRole('button', { name: 'ออกจากระบบ' })).toBeVisible();
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${device}-more.png` });
    }
  });

  test(`explore fits a ${device}`, async ({ browser }) => {
    const page = await open(browser, `e2e-r-x-${device}`, device, '/app/explore');
    await page.route('**/bff/directory/map**', (route) =>
      route.fulfill({
        json: {
          stations: [station(1, 'Bangkok FM', 13.75, 100.5), station(2, 'Chiang Mai Radio', 18.79, 98.98), station(3, 'Phuket Wave', 7.88, 98.39), station(4, 'Khon Kaen Hit', 16.43, 102.83), station(5, 'Hat Yai News', 7.01, 100.47), station(6, 'Pattaya Beach Radio', 12.93, 100.88)],
          unmapped: [],
          attribution: 'Radio Browser',
        },
      }),
    );
    await page.getByLabel('ประเทศ').fill('ประเทศไทย');
    await expect(page.getByTestId('explore-station')).toHaveCount(6);
    await fits(page, `${device}-explore`);
    const stage = await page.locator('.explore-stage').boundingBox();
    // The map takes most of the screen, not a strip under the menus.
    expect(stage!.height).toBeGreaterThan(DEVICES[device].height * 0.45);
    if (device !== 'ipad-landscape') {
      await page.getByRole('button', { name: 'เล่น Bangkok FM' }).click();
      await expect(page.getByTestId('explore-pick')).toBeVisible();
      await fits(page, `${device}-explore-picked`);
      // At rest the sheet shows whole stations only (Tar 2026-10-10): the picked one first, three on a phone, five
      // on an upright tablet, none cut in half. The player is one capsule on the map, clear of the sheet and the menu.
      const rows = device === 'iphone' ? 3 : 5;
      const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
      const panel = await box('.explore-panel');
      const whole = await page.evaluate(() => {
        const p = document.querySelector('.explore-panel')!.getBoundingClientRect();
        return [...document.querySelectorAll('[data-testid=explore-pick], .explore-list li')].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0 && r.bottom > p.top && r.top < p.bottom).map((r) => r.top >= p.top && r.bottom <= p.bottom + 1);
      });
      expect(whole, `${device}: stations in the resting sheet`).toEqual(Array(rows).fill(true));
      await expect(page.getByTestId('explore-pick')).toContainText('Bangkok FM');
      const player = await box('[data-testid=player]');
      expect(player.height).toBeLessThanOrEqual(64);
      expect(player.y + player.height).toBeLessThanOrEqual(panel.y);
      expect(panel.y + panel.height).toBeLessThanOrEqual(DEVICES[device].height - (device === 'iphone' ? 56 : 0));
      // A tap on the handle folds the sheet down to its handle and the count, and the player comes down with it;
      // another tap, or picking a station, brings the three stations back (Tar 2026-10-11).
      const handle = page.getByRole('button', { name: 'ขยายหรือย่อรายการสถานี' });
      await handle.click();
      await expect(handle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('explore-pick')).toBeHidden();
      await expect(page.getByRole('heading', { name: 'โหลดแล้ว 6 สถานี' })).toBeVisible();
      await expect.poll(async () => (await box('.explore-panel')).height).toBe(64);
      const folded = await box('[data-testid=player]');
      expect(folded.y).toBeGreaterThan(player.y + 100);
      await fits(page, `${device}-explore-folded`);
      await handle.click();
      await expect(handle).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByTestId('explore-pick')).toBeVisible();
      await expect.poll(async () => (await box('.explore-panel')).height).toBe(panel.height);
      await page.getByRole('button', { name: 'เปลี่ยนเป็นลูกโลก' }).isVisible();
    }
  });

  test(`staff pages fit a ${device}`, async ({ browser }) => {
    const page = await open(browser, `e2e-r-admin-${device}`, device, '/admin/stations');
    const folded = device !== 'ipad-landscape';
    for (const theme of ['minimal', 'control-room', 'broadcast-rack', 'daylight-bento', 'workbench']) {
      // On a phone or an upright tablet the menu folds behind one button; the theme picker lives inside it.
      const menu = page.getByRole('button', { name: 'เปิดเมนู' });
      if (folded && (await menu.isVisible())) await menu.click();
      await page.getByLabel('เลือกธีมหน้าทีมงาน').selectOption(theme);
      await expect(page.locator(`.t-${theme}`).first()).toBeAttached();
      if (folded) await fits(page, `${device}-admin-${theme}-menu`);
      for (const path of ['/admin/stations', '/admin/overview', '/admin/directory', '/admin/settings']) {
        await page.goto(`${stack.base}${path}`);
        await fits(page, `${device}-admin-${theme}${path.replace('/admin/', '-')}`);
      }
      await page.goto(`${stack.base}/admin/stations`);
    }
  });
}
