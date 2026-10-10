import { WEB_THEMES } from '../src/lib/web-themes';
import { Browser, expect, Page, test } from '@playwright/test';
import { registerBrowserCleanup, startStack, Stack } from './stack';

registerBrowserCleanup();

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
// Each visual case issues many catalog reads from one localhost address. Isolate only
// transient catalog/shared-admin read counters in this disposable database; production limits stay enabled.
test.beforeEach(async () => {
  await stack.api.sql("DELETE FROM rate_limit_counters WHERE bucket LIKE 'ip:%:catalog' OR bucket LIKE 'user:%:read'");
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


// Each batch layout uses the production app and the shared media element, not a standalone mockup.
for (const { id: theme, name: label } of WEB_THEMES.filter(t => !['classic', 'radio-wall'].includes(t.id))) {
  test(`${theme}: desktop pages, persistent player, all accents and shared mobile layout`, async ({ browser }) => {
    test.setTimeout(180_000);
    const admin = await open(browser, 'e2e-th-admin', '/admin/settings');
    const form = admin.getByRole('form', { name: 'ธีมของเว็บผู้ใช้' });
    await expect(form.locator('.theme-preview')).toHaveCount(WEB_THEMES.length);
    await form.locator(`input[name=web-theme][value="${theme}"]`).check();
    await form.getByRole('button', { name: 'ใช้ธีมนี้กับผู้ใช้ทุกคน' }).click();
    await expect(form.getByRole('status')).toContainText('บันทึกแล้ว');
    const page = await open(browser, `e2e-batch-${theme}`, '/app/home');
    await expect(page.getByTestId('app-frame')).toHaveClass(new RegExp(`t-${theme}`));
    await expect(page.getByTestId('player')).toHaveCount(0);
    const desktop = theme === 'preset-wall' ? page.locator('#wall') : ['shelves','studio'].includes(theme) ? page.locator('.shelf-curated') : page.locator('.home-shell');
    if (['cockpit','head-unit','signal-dial','tune-world'].includes(theme)) await page.locator('.tuning-stations ol button').filter({ hasText: 'Wall Jazz FM' }).click();
    await desktop.getByRole('button', { name: 'เล่น Wall Jazz FM', exact: true }).first().click();
    await page.locator('.player-screen video').evaluate(v => v.setAttribute('data-kept', 'batch'));
    if (['cockpit','head-unit','signal-dial','tune-world'].includes(theme)) {
      await page.locator('.tuning-stations ol button').filter({ hasText: 'Wall News TH' }).click();
      await expect(page.locator('.station-focus')).toContainText('Wall News TH');
      await expect(page.locator('.player-screen video')).toHaveAttribute('src', 'https://stream.example.com/jazz.aac');
    }
    if (['cockpit','head-unit','country-window'].includes(theme)) {
      await page.getByRole('button', { name: 'บันทึกสถานีที่เลือกในพรีเซ็ต 1', exact: true }).click();
      const stored = await page.evaluate(()=>JSON.parse(localStorage.getItem('tunedeck.web.presets') ?? '[]'));
      expect(stored[0].url).toBe(theme === 'country-window' ? 'https://stream.example.com/jazz.aac' : 'https://stream.example.com/news.aac');
      await expect(page.locator('.player-screen video')).toHaveAttribute('src', 'https://stream.example.com/jazz.aac');
      await page.getByRole('button', { name: 'ลบพรีเซ็ต 1', exact: true }).click();
      expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('tunedeck.web.presets') ?? '[]')[0])).toBeNull();
    }
    // Country changes fetch a different list but never start a new stream.
    const control = page.locator('select[id$=country]:visible').first();
    if (await control.count()) await control.selectOption('JP');
    await expect(page.locator('.player-screen video')).toHaveAttribute('src', 'https://stream.example.com/jazz.aac');
    for (const width of [1360, 1920]) {
      await page.setViewportSize({ width, height: width === 1360 ? 860 : 1080 });
      for (const [, path] of [['หน้าแรก', '/app/home'], ['วิทยุ', '/app/radio'], ['สำรวจ', '/app/explore'], ['การตั้งค่า', '/app/settings'], ['อุปกรณ์', '/app/devices'], ['ความเป็นส่วนตัว', '/app/privacy'], ['ภาพรวม', '/app/overview']]) {
        const nav = page.locator('.theme-top-nav:visible, .side-nav:visible');
        if (await page.locator('.theme-top-nav:visible').count() && path !== '/app/home' && path !== '/app/radio' && path !== '/app/explore') {
          await page.locator('.theme-account').evaluate((d: HTMLDetailsElement) => { d.open = true; });
        }
        // Use the destination rather than translated labels, which can differ on account pages.
        await nav.locator(`a[href="${path}"]:not(.brand)`).click();
        await expect(page).toHaveURL(`${stack.base}${path}`, { timeout: 15_000 });
        await expect(page.locator('.player-screen video')).toHaveAttribute('data-kept', 'batch');
        await expect(page.locator('[data-testid=player]:visible')).toHaveCount(1);
        const dock = await page.locator('[data-testid=player]:visible').boundingBox();
        expect(dock!.y + dock!.height).toBeLessThanOrEqual((await page.viewportSize())!.height);
        await expect(page.locator('.player-screen video')).toHaveAttribute('src', 'https://stream.example.com/jazz.aac');
        await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); });
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${theme} ${width} ${path}`).toBeLessThanOrEqual(0);
        if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/${theme}-${width}-${path.split('/').pop()}.png` });
      }
    }
    await page.goto(`${stack.base}/app/settings`);
    for (const mode of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: mode });
      for (const accent of ['default', 'green', 'blue', 'rose', 'violet']) {
        await page.locator(`.accents input[value="${accent}"]`).check();
        await expect(page.getByTestId('app-frame')).toHaveAttribute('data-accent', accent);
        const contrast = await page.getByTestId('app-frame').evaluate(frame => {
          const style = getComputedStyle(frame);
          const luminance = (hex: string) => {
            const rgb = hex.trim().slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
            return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
          };
          const a = luminance(style.getPropertyValue('--web-accent'));
          const b = luminance(style.getPropertyValue('--web-accent-ink'));
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        });
        expect(contrast, `${theme} ${mode} ${accent} text on accent`).toBeGreaterThanOrEqual(4.5);
      }
      await page.goto(`${stack.base}/app/home`);
      // Wide Home hydrates from the shared phone structure. Wait for its presenter,
      // then read both colours atomically so a replaced SSR heading cannot yield "".
      const home = ({cockpit:'.dashboard-home','head-unit':'.dashboard-home','signal-dial':'.tuning-home','tune-world':'.tuning-home','language-lanes':'.language-home','map-home':'.map-home-layout','night-garden':'.garden-home-layout',daylight:'.daylight-home'} as Record<string,string>)[theme];
      if (home) await expect(page.locator(home)).toBeVisible();
      await expect.poll(() => page.getByTestId('app-frame').evaluate(frame => {
        const headline = frame.querySelector('.home-shell h1');
        return !!headline && getComputedStyle(headline).color !== '' && getComputedStyle(headline).color === getComputedStyle(frame).color;
      }), { message: `${theme} ${mode} headline must inherit the theme foreground` }).toBe(true);
      if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/${theme}-${mode}-home.png` });
      await page.goto(`${stack.base}/app/settings`);
    }
    for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`${stack.base}/app/home`);
      await expect(page.locator('.shelf-home')).toBeHidden();
      await expect(page.locator('.preset-discovery')).toBeHidden();
      await expect(page.locator('.side-nav')).toBeHidden();
      await expect(page.locator('.theme-top-nav')).toBeHidden();
      await expect(page.locator('.wall-tabs')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/${theme}-${viewport.width}-home.png` });
    }
    // Verify both edges of the shared desktop guard without changing the mobile regression file.
    await page.setViewportSize({ width: 1101, height: 860 });
    await page.goto(`${stack.base}/app/home`);
    const chrome = page.locator('.theme-top-nav, .side-nav').first();
    await expect(chrome).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1100, height: 860 });
    await expect(chrome).toBeHidden();
    await expect(page.locator('.wall-tabs')).toBeVisible();
    await page.setViewportSize({ width: 1360, height: 500 });
    await expect(chrome).toBeHidden();
    await expect(page.locator('.wall-tabs')).toBeVisible();
    await form.getByRole('radio', { name: /ดั้งเดิม/ }).check();
    await form.getByRole('button', { name: 'ใช้ธีมนี้กับผู้ใช้ทุกคน' }).click();
    await expect(form.getByRole('status')).toContainText('บันทึกแล้ว');
    await page.context().close();
    await admin.context().close();
  });
}

test('login without a requested destination opens Home', async ({ browser }) => {
  stack.idp.setUser('e2e-home-default');
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${stack.base}/auth/login`);
  await expect(page).toHaveURL(`${stack.base}/app/home`);
  await context.close();
});

for (const theme of ['map-home', 'night-garden', 'tune-world'].filter(id => WEB_THEMES.some(theme => String(theme.id) === id))) {
  test(`${theme}: map selection is keyboard accessible and never autoplays`, async ({ browser }) => {
    const admin = await open(browser, 'e2e-th-admin', '/admin/settings');
    const form = admin.getByRole('form', { name: 'ธีมของเว็บผู้ใช้' });
    await form.locator(`input[value="${theme}"]`).check();
    await form.getByRole('button', { name: 'ใช้ธีมนี้กับผู้ใช้ทุกคน' }).click();
    await expect(form.getByRole('status')).toContainText('บันทึกแล้ว');
    stack.idp.setUser(`map-select-${theme}`);
    const page = await (await browser.newContext({ viewport: { width: 1360, height: 860 } })).newPage();
    await page.route('**/bff/directory/map**', route => route.fulfill({ json: { stations: [{ id: 'fixture-map-jazz', name: 'Fixture Map Jazz', country: 'TH', language: 'th', genres: ['jazz'], codec: 'aac', bitrateKbps: 96, streamUrl: 'https://map.example.test/jazz.aac', lat: 13.75, lon: 100.5 }], unmapped: [] } }));
    await page.goto(`${stack.base}/auth/login?returnTo=/app/home`);
    await expect(page.getByTestId('app-frame')).toHaveClass(new RegExp(`t-${theme}`));
    await page.locator('.map-station-picker select').selectOption('fixture-map-jazz');
    await expect(page.locator('.station-focus')).toContainText('Fixture Map Jazz');
    await expect(page.getByTestId('player')).toHaveCount(0);
    await expect(page.locator('.player-screen video')).not.toHaveAttribute('src', /.+/);
    await page.getByRole('button', { name: 'เล่น Fixture Map Jazz', exact: true }).click();
    await expect(page.locator('.player-screen video')).toHaveAttribute('src', 'https://map.example.test/jazz.aac');
    if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/${theme}-map-selection.png` });
  });
}

test('language lanes independently filter actual station languages without starting audio', async ({ browser }) => {
  test.skip(!WEB_THEMES.some(theme => String(theme.id) === 'language-lanes'), 'Language theme is introduced in batch 4');
  const admin = await open(browser, 'e2e-th-admin', '/admin/settings');
  const form = admin.getByRole('form', { name: 'ธีมของเว็บผู้ใช้' });
  await form.locator('input[value="language-lanes"]').check();
  await form.getByRole('button', { name: 'ใช้ธีมนี้กับผู้ใช้ทุกคน' }).click();
  await expect(form.getByRole('status')).toContainText('บันทึกแล้ว');
  stack.idp.setUser('language-lanes-fixture');
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 860 } })).newPage();
  await page.route('**/bff/directory/top**', route => route.fulfill({ json: { stations: ['en', 'ja', 'fr'].map(language => ({ id: `fixture-${language}`, name: `Fixture ${language}`, country: 'TH', language, genres: ['news'], codec: 'aac', bitrateKbps: 96, streamUrl: `https://fixture.example.test/${language}.aac` })) } }));
  await page.goto(`${stack.base}/auth/login?returnTo=/app/home`);
  const first = page.locator('.language-lane').first();
  await first.locator('select').first().selectOption('ja');
  await expect(first.getByRole('heading', { name: 'Fixture ja' })).toBeVisible();
  await expect(first.getByRole('heading', { name: 'Fixture en' })).toHaveCount(0);
  await expect(page.getByTestId('player')).toHaveCount(0);
  await first.getByRole('button', { name: 'เล่น Fixture ja', exact: true }).click();
  await expect(page.locator('.player-screen video')).toHaveAttribute('src', 'https://fixture.example.test/ja.aac');
  await page.locator('.language-lane').nth(1).locator('select').first().selectOption('fr');
  await expect(page.locator('.player-screen video')).toHaveAttribute('src', 'https://fixture.example.test/ja.aac');
});

test('browser presets survive reload, reject malformed entries and disclose failed storage', async ({ browser }) => {
  const admin = await open(browser, 'e2e-th-admin', '/admin/settings');
  const form = admin.getByRole('form', { name: 'ธีมของเว็บผู้ใช้' });
  await form.locator('input[value="country-window"]').check();
  await form.getByRole('button', { name: 'ใช้ธีมนี้กับผู้ใช้ทุกคน' }).click();
  await expect(form.getByRole('status')).toContainText('บันทึกแล้ว');
  const page = await open(browser, 'preset-storage-fixture', '/app/home');
  await page.getByRole('button', { name: 'บันทึกสถานีที่เลือกในพรีเซ็ต 1', exact: true }).click();
  const saved = await page.evaluate(()=>JSON.parse(localStorage.getItem('tunedeck.web.presets') ?? '[]')[0]);
  expect(saved.url).toMatch(/^https:\/\//);
  await page.reload();
  await expect(page.locator('.theme-presets').getByRole('button', { name: `เล่น ${saved.name}`, exact: true })).toBeVisible();
  await expect(page.getByTestId('player')).toHaveCount(0);
  await page.evaluate(()=>localStorage.setItem('tunedeck.web.presets', JSON.stringify([{name:'Bad fixture',url:'javascript:alert(1)'},null])));
  await page.reload();
  await expect(page.locator('.theme-presets').getByRole('button', { name: 'เล่น Bad fixture' })).toHaveCount(0);
  await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw new DOMException('Fixture denied','QuotaExceededError')};});
  await page.getByRole('button', { name: 'บันทึกสถานีที่เลือกในพรีเซ็ต 1', exact: true }).click();
  await expect(page.locator('.theme-presets').getByRole('alert')).toContainText('บันทึกพรีเซ็ตในเบราว์เซอร์ไม่ได้');
  await expect(page.getByTestId('player')).toHaveCount(0);
});

 test('a throttled catalog is reported as a load failure in advanced Home', async ({ browser }) => {
  test.skip(!WEB_THEMES.some(theme => String(theme.id) === 'map-home'), 'Map Home arrives in batch 5');
  const admin = await open(browser, 'e2e-th-admin', '/admin/settings');
  const form = admin.getByRole('form', { name: 'ธีมของเว็บผู้ใช้' });
  await form.locator('input[value="map-home"]').check();
  await form.getByRole('button', { name: 'ใช้ธีมนี้กับผู้ใช้ทุกคน' }).click();
  await expect(form.getByRole('status')).toContainText('บันทึกแล้ว');
  await fetch(`${stack.api.url}/v1/catalog/radio?limit=100`);
  await stack.api.sql("UPDATE rate_limit_counters SET hits = 100000 WHERE bucket LIKE 'ip:%:catalog' AND window_start = date_trunc('minute', now())");
  const blocked = await fetch(`${stack.api.url}/v1/catalog/radio?limit=100`);
  expect(blocked.status).toBe(429);
  const page = await open(browser, 'e2e-catalog-throttled', '/app/home');
  await expect(page.locator('.home-shell > [role=alert]')).toBeVisible();
  await expect(page.locator('.map-shortcuts').first()).not.toContainText('ยังไม่มีสถานีที่เผยแพร่');
  await expect(page.getByTestId('player')).toHaveCount(0);
 });
