import { expect, test } from '@playwright/test';
import { startStack, Stack } from './stack';

let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack();
});

test.afterAll(async () => {
  await stack?.stop();
});

const station = (n: number, name: string, lat: number, lon: number, country: string) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  name,
  country,
  language: 'thai',
  genres: ['pop'],
  codec: 'mp3',
  bitrateKbps: 128,
  streamUrl: `https://s${n}.example.test/live.mp3`,
  lat,
  lon,
});

test('explore shows community stations on a map or a globe, plays one and adds it to my links', async ({ browser }) => {
  stack.idp.setUser('e2e-explorer');
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${stack.base}/auth/login?returnTo=/app/explore`);
  await expect(page.getByRole('heading', { name: 'สำรวจวิทยุทั่วโลก' })).toBeVisible();
  // The test API has no Radio Browser configured, so the real answer is an error the page explains.
  await expect(page.getByText('โหลดสถานีไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง')).toBeVisible();

  await page.route('**/bff/directory/map**', (route) =>
    route.fulfill({
      json: {
        stations: [station(1, 'Bangkok <b>FM</b>', 13.75, 100.5, 'TH'), station(2, 'Chiang Mai Radio', 18.79, 98.98, 'TH'), station(3, 'Tokyo Wave', 35.68, 139.69, 'JP')],
        unmapped: [{ ...station(4, 'Hat Yai Online', 0, 0, 'TH'), lat: undefined, lon: undefined }],
        attribution: 'Radio Browser',
      },
    }),
  );
  // The country is typed (Thai name, English name or code) with suggestions.
  await page.getByLabel('ประเทศ').fill('ประเทศไทย');
  await expect(page.getByTestId('explore-station')).toHaveCount(3);
  await expect(page.getByRole('heading', { name: 'โหลดแล้ว 3 สถานี' })).toBeVisible();
  // Stations without coordinates are still listed and playable, with no dot on the map.
  await expect(page.getByRole('heading', { name: 'สถานีที่ไม่มีตำแหน่งบนแผนที่ 1 สถานี' })).toBeVisible();
  await expect(page.getByTestId('explore-unmapped')).toContainText('Hat Yai Online');
  // Names are text, never markup.
  await expect(page.getByTestId('explore-station').first()).toContainText('Bangkok <b>FM</b>');
  await expect(page.getByTestId('world-map').locator('.leaflet-interactive')).toHaveCount(3);
  // Picking a dot shows the station without playing it.
  await page.getByTestId('world-map').getByRole('button', { name: 'Chiang Mai Radio' }).click();
  await expect(page.getByTestId('explore-pick')).toContainText('Chiang Mai Radio');
  await expect(page.getByTestId('player')).toHaveCount(0);
  // Genre chips come from the loaded stations; the light and dark looks are the viewer's choice and are remembered.
  await expect(page.getByRole('group', { name: 'ประเภท' }).getByRole('button', { name: 'Pop' })).toBeVisible();
  await page.getByRole('group', { name: 'สีหน้าจอ' }).getByRole('button', { name: 'มืด' }).click();
  if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/explore-map-dark.png`, fullPage: true });
  await page.getByRole('group', { name: 'สีหน้าจอ' }).getByRole('button', { name: 'สว่าง' }).click();
  if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/explore-map.png`, fullPage: true });

  await page.getByRole('button', { name: 'เล่น Tokyo Wave' }).click();
  // One row: the station, its state and Stop. No time line, since live radio cannot be wound back.
  await expect(page.getByTestId('player')).toHaveAttribute('aria-label', 'กำลังเล่น: Tokyo Wave');
  await expect(page.getByTestId('player')).toContainText('Tokyo Wave');
  await expect(page.locator('.player-screen video')).not.toHaveAttribute('controls');
  await expect(page.getByTestId('player').getByRole('button', { name: 'หยุด' })).toBeVisible();
  // A fake stream never starts, so the player says it is still connecting (or that it cannot play), never "playing".
  await expect(page.getByTestId('player').locator('.player-state')).toHaveAttribute('data-state', /connecting|failed/);
  await expect(page.getByTestId('explore-pick')).toContainText('Tokyo Wave');
  await page.getByRole('button', { name: 'เพิ่มในลิงก์ของฉัน' }).click();
  await expect(page.getByText('เพิ่ม Tokyo Wave ในลิงก์ของฉันแล้ว')).toBeVisible();
  await page.getByRole('button', { name: 'เพิ่มในลิงก์ของฉัน' }).click();
  await expect(page.getByText('สถานีนี้อยู่ในลิงก์ของฉันแล้ว')).toBeVisible();

  // The globe is remembered as the viewer's choice; without WebGL the page says so and the list still works.
  await page.getByRole('button', { name: 'ลูกโลก' }).click();
  await expect(page.getByTestId('world-globe').or(page.getByText('เบราว์เซอร์นี้แสดงลูกโลก 3 มิติไม่ได้ (ไม่รองรับ WebGL) ใช้แผนที่แทนได้'))).toBeVisible();
  await page.waitForTimeout(1500);
  if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/explore-globe.png`, fullPage: true });
  await page.reload();
  await expect(page.getByRole('button', { name: 'ลูกโลก' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'สว่าง' })).toHaveAttribute('aria-pressed', 'true');

  await page.goto(`${stack.base}/app/radio`);
  await expect(page.getByTestId('channel')).toHaveText(['Tokyo Wave▶✕ญี่ปุ่น · s3.example.test']);
});
