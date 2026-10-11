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
  await page.route('https://stream.example.com/**', route => route.fulfill({ contentType: 'audio/wav', body: playableWave() }));
  await page.getByRole('button', { name: 'เล่น Wall Jazz FM' }).click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing');
  await expect.poll(() => page.locator('.player-screen video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.25);
  if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/classic-home.png` });
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
  // Every screenshot must be served and decoded, including lazy images below the fold.
  await expect(form.locator('img.theme-preview')).toHaveCount(WEB_THEMES.length);
  for (const image of await form.locator('img.theme-preview').all()) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1360);
  }

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
  await user.route('https://stream.example.com/**', route => route.fulfill({ contentType: 'audio/wav', body: playableWave() }));
  await user.getByRole('button', { name: 'เล่น Wall News TH' }).click();
  await expect(user.getByTestId('player')).toHaveAttribute('data-state', 'playing');
  await expect.poll(() => user.locator('.player-screen video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.25);
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
    if(theme==='explorer')await expect(page.locator('.atlas-menu-close')).toBeHidden();
    const desktop = theme === 'preset-wall' ? page.locator('#wall') : ['shelves','studio'].includes(theme) ? page.locator('.shelf-curated') : page.locator('.home-shell');
    if (['cockpit','head-unit','signal-dial','tune-world'].includes(theme)) await page.locator('.tuning-stations ol button').filter({ hasText: 'Wall Jazz FM' }).click();
    await page.route('https://stream.example.com/**', route => route.fulfill({ contentType: 'audio/wav', body: playableWave() }));
    await desktop.getByRole('button', { name: 'เล่น Wall Jazz FM', exact: true }).first().click();
    await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing');
    await expect.poll(() => page.locator('.player-screen video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.25);
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
        if (theme === 'explorer' && path === '/app/explore') continue;
        await nav.locator(`a[href="${path}"]:not(.brand)`).click();
        await expect(page).toHaveURL(`${stack.base}${path}`, { timeout: 15_000 });
        if(theme==='explorer')await expect(page.locator('.atlas-menu-close')).toBeHidden();
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
      const home = ({cockpit:'.dashboard-home','head-unit':'.dashboard-home','signal-dial':'.tuning-home','tune-world':'.tuning-home','language-lanes':'.language-home','map-home':'.map-home-layout','night-garden':'.garden-home-layout',daylight:'.daylight-home',explorer:'.explorer-home'} as Record<string,string>)[theme];
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
      await expect(page.locator(theme==='explorer'?'.atlas-home':'.wall-tabs')).toBeVisible();
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
    await expect(page.locator(theme==='explorer'?'.atlas-home':'.wall-tabs')).toBeVisible();
    await page.setViewportSize({ width: 1360, height: 500 });
    await expect(chrome).toBeHidden();
    await expect(page.locator(theme==='explorer'?'.atlas-home':'.wall-tabs')).toBeVisible();
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


// A real decoded PCM stream, intercepted at an HTTPS origin. Merely assigning src
// does not test CSP or playback; currentTime advancing does. No broadcaster dependency.
function playableWave(): Buffer {
  const rate = 8000, samples = rate * 120;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / rate) * 1200), 44 + i * 2);
  return data;
}

test('Explorer decodes HTTPS audio on Home, browses without autoplay and retries a failed stream', async ({ browser }) => {
  const admin = await open(browser, 'e2e-th-admin', '/admin/settings');
  const form = admin.getByRole('form', { name: 'ธีมของเว็บผู้ใช้' });
  await form.locator('input[value="explorer"]').check();
  await form.getByRole('button', { name: 'ใช้ธีมนี้กับผู้ใช้ทุกคน' }).click();
  await expect(form.getByRole('status')).toContainText('บันทึกแล้ว');
  const page = await open(browser, 'explorer-audio', '/app/home');
  await expect(page.locator('.explorer-home')).toBeVisible();
  const wave = playableWave();
  let fail = true;
  let requests = 0;
  await page.route('https://stream.example.com/**', route => {
    requests++;
    return fail ? route.abort() : route.fulfill({ contentType: 'audio/wav', body: wave, headers: { 'access-control-allow-origin': '*' } });
  });
  const video = page.locator('.player-screen video');
  await expect(video).not.toHaveAttribute('src', /.+/);
  await page.getByRole('button', { name: 'เล่น Wall Jazz FM', exact: true }).click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'failed');
  fail = false;
  await page.getByRole('button', { name: 'เล่น Wall Jazz FM', exact: true }).click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.25);
  expect(requests).toBeGreaterThanOrEqual(2);
  // Reference geometry and real controls: no fake progress/play state.
  expect((await page.locator('.explorer-nav').boundingBox())!.width).toBe(244);
  expect((await page.locator('.home-shell').boundingBox())!.x).toBe(244);
  expect((await page.locator('.explorer-heading').boundingBox())!.x).toBe(266);
  expect((await page.locator('.player-dock').boundingBox())!.height).toBe(76);
  const card = await page.locator('.explorer-card').first().boundingBox();
  expect(card!.width / card!.height).toBeCloseTo(16 / 9, 2);
  const controls = page.getByTestId('player');
  await controls.getByRole('button', { name: 'พักการเล่น', exact: true }).click();
  await expect(controls).toHaveAttribute('data-state', 'paused');
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await controls.getByRole('button', { name: 'เล่นต่อ', exact: true }).click();
  await expect(controls).toHaveAttribute('data-state', 'playing');
  await controls.getByRole('button', { name: 'ปิดเสียง', exact: true }).click();
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  const volume = controls.getByRole('slider', { name: 'ระดับเสียง' });
  await volume.press('Home');
  await volume.press('ArrowRight');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.volume)).toBeCloseTo(.05, 2);
  await controls.getByRole('button', { name: 'เปิดเสียง', exact: true }).click();
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
  if (process.env.ADMIN_SHOTS_DIR) {
    await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/explorer-reference-light.png`, animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/explorer-reference-dark.png`, animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'light' });
  }

  await video.evaluate(v => v.setAttribute('data-audio-kept', 'yes'));
  // Clicking a feed card scrolls it into view; catalog order is not fixed.
  const jazzIndex = Number(await page.locator('.explorer-feed article').filter({ has: page.getByRole('button', { name: 'เล่น Wall Jazz FM', exact: true }) }).getAttribute('data-index'));
  const browseStep = page.getByRole('button', { name: jazzIndex > 0 ? 'สถานีก่อนหน้า' : 'สถานีถัดไป', exact: true });
  await expect(browseStep).toBeEnabled();
  await browseStep.click();
  await expect(page.getByRole('button', { name: 'เล่น Wall News TH', exact: true })).toBeInViewport();
  await expect(video).toHaveAttribute('src', 'https://stream.example.com/jazz.aac');
  await page.getByLabel('ค้นหาสถานี', { exact: true }).fill('no-match');
  await expect(page.locator('.explorer-feed article')).toHaveCount(0);
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing');
  await page.getByLabel('ค้นหาสถานี', { exact: true }).fill('');
  if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/explorer-playing.png` });
  await page.getByLabel('ค้นหาสถานี', { exact: true }).fill('Jazz');
  await expect(page.locator('.explorer-search-results')).toBeVisible();
  await expect(page.locator('.explorer-search-results').getByRole('button', { name: 'เล่น Wall Jazz FM', exact: true })).toBeVisible();
  await expect(controls).toHaveAttribute('data-state', 'playing');
  await page.getByLabel('ค้นหาสถานี', { exact: true }).fill('');
  const appearance = page.getByRole('switch', { name: 'โหมดมืด', exact: true });
  await appearance.click();
  await expect(appearance).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.explorer-ui')).toHaveAttribute('data-explorer-look', 'dark');
  await appearance.click();
  await expect(appearance).toHaveAttribute('aria-checked', 'false');
  await page.locator('.explorer-nav').getByRole('link', { name: 'หน้าแรก', exact: true }).click();
  await expect(page.locator('.explorer-heroes')).toBeVisible();
  await expect(controls).toHaveAttribute('data-state', 'playing');
  if (process.env.ADMIN_SHOTS_DIR) await page.screenshot({ path: `${process.env.ADMIN_SHOTS_DIR}/explorer-reference-browse.png`, animations: 'disabled' });
  for (const destination of ['การตั้งค่า', 'อุปกรณ์', 'วิทยุ']) {
    const before = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
    await page.locator('.side-nav').getByRole('link', { name: destination, exact: true }).click();
    await expect(video).toHaveAttribute('data-audio-kept', 'yes');
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(before);
    await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing');
  }
});

test('Explorer Radio combines navigation and reference map with real playback', async ({browser})=>{
 test.setTimeout(90_000);
 const admin=await open(browser,'e2e-th-admin','/admin/settings');
 const form=admin.getByRole('form',{name:'ธีมของเว็บผู้ใช้'});
 await form.locator('input[value="explorer"]').check();
 const save=form.getByRole('button',{name:'ใช้ธีมนี้กับผู้ใช้ทุกคน'});
 if(await save.isEnabled()){await save.click();await expect(form.getByRole('status')).toContainText('บันทึกแล้ว');}
 const page=await open(browser,'explorer-map','/app/home');
 const points=[['COOL Thailand',13.75,100.5],['BBC London',51.5,-.12],['KEXP Seattle',47.6,-122.3],['Brasil Radio',-23.55,-46.63],['Melbourne Radio',-37.8,144.96],['Tokyo Radio',35.68,139.69]] as const;
 const countryRequests:string[]=[];
 const codes=['TH','GB','US','BR','AU','JP'];
 await page.route('**/bff/directory/map**',r=>{
  const country=new URL(r.request().url()).searchParams.get('country')||'';countryRequests.push(country);
  const stations=points.map(([name,lat,lon],i)=>({id:`map-${i}`,name,lat,lon,country:codes[i],language:'en',genres:i===1?['news']:['music'],codec:'aac',bitrateKbps:96,streamUrl:`https://stream.example.com/map-${i}.aac`})).filter(s=>!country||s.country===country);
  return r.fulfill({json:{stations,unmapped:country==='JP'?[{id:'jp-no-geo',name:'Tokyo without coordinates',country:'JP',language:'ja',genres:['music'],codec:'aac',bitrateKbps:96,streamUrl:'https://stream.example.com/jp-no-geo.aac'}]:[]}});
 });
 await page.route('https://stream.example.com/**',r=>r.fulfill({contentType:'audio/wav',body:playableWave()}));
 const nav=page.locator('.explorer-nav');
 await expect(nav.getByRole('link',{name:'สำรวจ',exact:true})).toHaveCount(0);
 await nav.getByRole('link',{name:'วิทยุ',exact:true}).click();
 await expect(page).toHaveURL(`${stack.base}/app/radio`);
 await expect(nav.getByRole('link',{name:'วิทยุ',exact:true})).toHaveAttribute('aria-current','page');
 const map=page.locator('.explorer-radio-map');
 await expect(map.getByTestId('world-map').getByRole('button',{name:'BBC London',exact:true})).toBeVisible();
 expect((await map.boundingBox())!.x).toBe(244);
 expect((await map.boundingBox())!.height).toBe(784);
 await expect(map.getByTestId('world-map')).toHaveCSS('background-color','rgb(38, 42, 92)');
 await expect(map.locator('.leaflet-control-zoom-in')).toHaveCSS('width','44px');
 await map.getByTestId('world-map').getByRole('button',{name:'BBC London',exact:true}).click();
 await expect(map.getByTestId('explore-pick')).toContainText('BBC London');
 await expect(page.getByTestId('player')).toHaveCount(0);
 await map.getByRole('button',{name:'เล่น',exact:true}).click();
 await expect(page.getByTestId('player')).toHaveAttribute('data-state','playing');
 const video=page.locator('.player-screen video');
 await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(.25);
 await map.getByRole('group',{name:'ประเภท'}).getByRole('button',{name:'MUSIC',exact:true}).click();
 await expect(map.getByTestId('world-map').getByRole('button',{name:'BBC London',exact:true})).toHaveCount(0);
 await expect(video).toHaveAttribute('src','https://stream.example.com/map-1.aac');
 await map.getByRole('group',{name:'ประเภท'}).getByRole('button',{name:'ทั้งหมด',exact:true}).click();
 await map.getByRole('button',{name:'ค้นหา',exact:true}).click();
 await map.getByLabel('ค้นหาสถานี', {exact:true}).fill('Tokyo');
 await expect(map.locator('.explorer-map-search-box li')).toHaveCount(1);
 await map.locator('.explorer-map-search-box li button').click();
 await expect(map.getByTestId('explore-pick')).toContainText('Tokyo Radio');
 await expect(video).toHaveAttribute('src','https://stream.example.com/map-1.aac');
 await map.getByRole('button',{name:'ค้นหา',exact:true}).click();
 await map.getByRole('button',{name:'ปิด',exact:true}).click();

 await map.getByRole('button',{name:'ค้นหา',exact:true}).click();
 const countryInput=map.getByRole('combobox',{name:'ประเทศ',exact:true});
 const beforeCountryTyping=countryRequests.length;
 await countryInput.fill('japan');
 await expect(map.getByRole('option')).toHaveCount(1);
 expect(countryRequests.length).toBe(beforeCountryTyping);
 if(process.env.ADMIN_SHOTS_DIR)await page.screenshot({path:`${process.env.ADMIN_SHOTS_DIR}/explorer-country-autocomplete.png`,animations:'disabled'});
 await countryInput.press('Enter');
 await expect.poll(()=>countryRequests.at(-1)).toBe('JP');
 await expect(map.locator('.explorer-search-results li')).toHaveCount(2);
 await expect(map.locator('.explorer-search-results')).toContainText('Tokyo without coordinates');
 await expect(video).toHaveAttribute('src','https://stream.example.com/map-1.aac');
 await expect(page.getByTestId('player')).toHaveAttribute('data-state','playing');
 await countryInput.fill('zzzzzz');
 await expect(map.getByRole('option')).toHaveCount(0);
 await expect(map.locator('.explorer-country-popup')).toContainText('ไม่พบประเทศ');
 await countryInput.press('Escape');
 await expect(map.locator('.explorer-map-search-box')).toBeVisible();
 await expect(countryInput).toHaveValue('ญี่ปุ่น');
 await countryInput.click();
 await map.getByRole('option',{name:/^ทั่วโลก/}).click();
 await expect.poll(()=>countryRequests.at(-1)).toBe('');
 await expect(map.locator('.explorer-search-results li')).toHaveCount(6);
 await expect(map.getByTestId('world-map').getByRole('button',{name:'BBC London',exact:true})).toBeVisible();
 await expect(countryInput).toHaveValue('ทั่วโลก');
 if(process.env.ADMIN_SHOTS_DIR){
  await page.waitForTimeout(200);
  await page.screenshot({path:`${process.env.ADMIN_SHOTS_DIR}/explorer-compact-search.png`,animations:'disabled'});
  await page.setViewportSize({width:1360,height:501});
  const panelBox=await map.locator('.explorer-map-search-box').boundingBox();const mapBox=await map.boundingBox();
  expect(panelBox!.y+panelBox!.height).toBeLessThanOrEqual(mapBox!.y+mapBox!.height);
  await page.screenshot({path:`${process.env.ADMIN_SHOTS_DIR}/explorer-compact-search-short.png`,animations:'disabled'});
  await page.setViewportSize({width:1360,height:860});
 }
 await map.getByRole('button',{name:'ปิด',exact:true}).click();
 if(process.env.ADMIN_SHOTS_DIR){
  await page.screenshot({path:`${process.env.ADMIN_SHOTS_DIR}/explorer-radio-map.png`});
  await page.setViewportSize({width:1920,height:1080});
  await page.screenshot({path:`${process.env.ADMIN_SHOTS_DIR}/explorer-radio-map-wide.png`});
 }
 await map.getByRole('button',{name:'ลูกโลก',exact:true}).click();
 await expect(map.getByTestId('world-globe')).toHaveAttribute('data-ready','true');
 await expect(map).toHaveAttribute('data-view','globe');
 await expect(map.getByTestId('world-globe')).toHaveCSS('background-color','rgb(236, 241, 247)');
 await page.waitForTimeout(900);
 const globeBefore=await map.getByTestId('world-globe').screenshot();
 await map.getByRole('button',{name:'ซูมเข้า',exact:true}).click();
 await page.waitForTimeout(350);
 expect((await map.getByTestId('world-globe').screenshot()).equals(globeBefore)).toBe(false);
 await map.getByRole('button',{name:'ซูมออก',exact:true}).click();
 await expect(page.getByTestId('player')).toHaveAttribute('data-state','playing');
 if(process.env.ADMIN_SHOTS_DIR){await page.waitForTimeout(600);await page.screenshot({path:`${process.env.ADMIN_SHOTS_DIR}/explorer-radio-globe-wide.png`});}
 if(process.env.ADMIN_SHOTS_DIR){
  await map.getByRole('button',{name:'ค้นหา',exact:true}).click();
  await map.getByRole('combobox',{name:'ประเทศ',exact:true}).fill('Thailand');
  await page.screenshot({path:`${process.env.ADMIN_SHOTS_DIR}/explorer-country-globe.png`,animations:'disabled'});
  await map.getByRole('combobox',{name:'ประเทศ',exact:true}).press('Escape');
  await map.getByRole('button',{name:'ปิด',exact:true}).click();
 }

 await map.getByRole('button',{name:'แผนที่',exact:true}).click();
 await expect(map).toHaveAttribute('data-view','map');
 await map.getByRole('button',{name:'ลูกโลก',exact:true}).click();
 await expect(map.getByTestId('world-globe')).toHaveAttribute('data-ready','true');
 await map.getByRole('button',{name:'แผนที่',exact:true}).click();
 await map.getByRole('link',{name:'คลังของฉัน',exact:true}).click();
 await expect(page).toHaveURL(`${stack.base}/app/radio?library=1`);
 await expect(page.getByRole('heading',{name:'วิทยุ',exact:true})).toBeVisible();
 await expect(page.getByTestId('player')).toHaveAttribute('data-state','playing');
 await page.goto(`${stack.base}/app/explore`);
 await expect(page.locator('.explorer-radio-map')).toBeVisible();
 await expect(page.locator('.explorer-nav').getByRole('link',{name:'วิทยุ',exact:true})).toHaveAttribute('aria-current','page');
 await page.setViewportSize({width:390,height:844});
 await page.goto(`${stack.base}/app/radio`);
 await expect(page.locator('.explorer-radio-map')).toBeVisible();
 await expect(page.locator('.atlas-header')).toBeVisible();
});

// Atlas replaces only Explorer's touch UI, preserving the actual account routes and media element.
test('Atlas touch: all menus, country requests, account pages, media continuity and full player',async({browser})=>{
 test.setTimeout(180_000);
 const admin=await open(browser,'e2e-th-admin','/admin/settings');
 const form=admin.getByRole('form',{name:'ธีมของเว็บผู้ใช้'});
 await form.locator('input[value=explorer]').check();
 const save=form.getByRole('button',{name:'ใช้ธีมนี้กับผู้ใช้ทุกคน'});
 if(await save.isEnabled()){await save.click();await expect(form.getByRole('status')).toContainText('บันทึกแล้ว')}
 const page=await open(browser,'atlas-th-user','/app/home');
 await page.route('https://stream.example.com/**',r=>r.fulfill({contentType:'audio/wav',body:playableWave()}));
 const requests:string[]=[];
 await page.route('**/bff/directory/map**',r=>{
  const country=new URL(r.request().url()).searchParams.get('country')||'';requests.push(country);
  return r.fulfill({json:{stations:[{id:'atlas-th',name:'Atlas Bangkok',lat:13.75,lon:100.5,country:'TH',language:'th',genres:['music'],codec:'aac',streamUrl:'https://stream.example.com/atlas.aac'}].filter(s=>!country||s.country===country),unmapped:[]}});
 });
 const menu=page.locator('.explorer-nav');
 const showMenu=async()=>{await page.getByRole('button',{name:'เปิดเมนูทั้งหมด'}).click();await expect(menu).toBeVisible();const close=menu.locator('.atlas-menu-close');await expect(close).toBeVisible();const box=await close.boundingBox();expect(box!.width).toBe(44);expect(box!.height).toBe(44)};
 const move=async(path:string)=>{await showMenu();await menu.locator(`a[href="${path}"]:not(.brand)`).click();await expect(page).toHaveURL(`${stack.base}${path}`);await expect(menu).toBeHidden()};
 await page.setViewportSize({width:390,height:844});
 await expect(page.locator('.atlas-home')).toBeVisible();
 await page.locator('.atlas-station').getByRole('button',{name:'เล่น Wall Jazz FM',exact:true}).first().click();
 await expect(page.getByTestId('player')).toHaveAttribute('data-state','playing');
 await expect.poll(()=>page.locator('.player-screen video').evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(.2);
 await page.locator('.player-screen video').evaluate(v=>v.setAttribute('data-kept','atlas'));
 for(const width of [390,820]){
  await page.setViewportSize({width,height:width===390?844:1180});
  await move('/app/home');
  await page.locator('.atlas-station-detail').first().click();
  await expect(page.getByRole('dialog',{name:'รายละเอียดสถานี'})).toBeVisible();
  await expect(page.locator('.player-screen video')).toHaveAttribute('src','https://stream.example.com/jazz.aac');
  if(process.env.ADMIN_SHOTS_DIR)await page.screenshot({path:`${process.env.ADMIN_SHOTS_DIR}/atlas-${width}-station-details.png`});
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog',{name:'รายละเอียดสถานี'})).toBeHidden();
  await showMenu();if(process.env.ADMIN_SHOTS_DIR)await page.screenshot({path:`${process.env.ADMIN_SHOTS_DIR}/atlas-${width}-all-menus.png`});await page.keyboard.press('Escape');
  for(const name of ['สำหรับคุณ','สถานีโปรด','ฟังล่าสุด','เพลง','กีฬา','ข่าวและพูดคุย','ตามประเทศ','ตามภาษา']){
   await showMenu();await menu.getByRole('button',{name,exact:true}).click();await expect(menu).toBeHidden();await expect(page.locator('.atlas-home h1')).toHaveText(name);
   if(process.env.ADMIN_SHOTS_DIR)await page.screenshot({path:`${process.env.ADMIN_SHOTS_DIR}/atlas-${width}-${['สำหรับคุณ','สถานีโปรด','ฟังล่าสุด','เพลง','กีฬา','ข่าวและพูดคุย','ตามประเทศ','ตามภาษา'].indexOf(name)}.png`});
  }
  for(const path of ['/app/home','/app/overview','/app/settings','/app/devices','/app/privacy','/app/radio?library=1','/app/radio']){
   await move(path);await expect(page).toHaveURL(`${stack.base}${path}`);
   await expect(page.locator('.player-screen video')).toHaveAttribute('data-kept','atlas');
   await expect(page.locator('.player-screen video')).toHaveAttribute('src','https://stream.example.com/jazz.aac');
   await expect(page.getByTestId('player')).toHaveAttribute('data-state','playing');
   expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(0);
   const player=await page.getByTestId('player').boundingBox(),dock=await page.locator('.atlas-bottom-nav').boundingBox();expect(player!.y+player!.height).toBeLessThanOrEqual(dock!.y);
   if(process.env.ADMIN_SHOTS_DIR)await page.screenshot({path:`${process.env.ADMIN_SHOTS_DIR}/atlas-${width}-${path.endsWith('library=1')?'library':path.split('/').at(-1)}.png`});
  }
  const map=page.locator('.explorer-radio-map');
  await map.getByRole('button',{name:'ค้นหา',exact:true}).click();
  const input=map.getByRole('combobox',{name:'ประเทศ',exact:true});const before=requests.length;
  await input.click();await input.fill('TH');expect(requests.length).toBe(before);if(process.env.ADMIN_SHOTS_DIR)await page.screenshot({path:`${process.env.ADMIN_SHOTS_DIR}/atlas-${width}-country-dropdown.png`});await input.press('Enter');await expect.poll(()=>requests.at(-1)).toBe('TH');
  await expect(map.locator('.explorer-search-results')).toContainText('Atlas Bangkok');
  if(process.env.ADMIN_SHOTS_DIR)await page.screenshot({path:`${process.env.ADMIN_SHOTS_DIR}/atlas-${width}-country-search.png`});
  await map.locator('.explorer-search-results').getByRole('button',{name:'Atlas Bangkok',exact:true}).click();await expect(map.getByTestId('explore-pick')).toContainText('Atlas Bangkok');
  await expect(page.locator('.player-screen video')).toHaveAttribute('src','https://stream.example.com/jazz.aac');
 }
 await page.getByRole('button',{name:'เปิดเครื่องเล่นเต็ม'}).click();
 const dialog=page.getByRole('dialog',{name:'กำลังฟัง'});await expect(dialog).toBeVisible();
 await dialog.getByRole('button',{name:'พักการเล่น',exact:true}).click();await expect(page.getByTestId('player')).toHaveAttribute('data-state','paused');
 await dialog.getByRole('button',{name:'เล่นต่อ',exact:true}).click();await expect(page.getByTestId('player')).toHaveAttribute('data-state','playing');
 await dialog.getByLabel('ตั้งเวลาหยุด').selectOption('30');
 if(process.env.ADMIN_SHOTS_DIR)await page.screenshot({path:`${process.env.ADMIN_SHOTS_DIR}/atlas-full-player.png`});
 await page.keyboard.press('Escape');await expect(dialog).toBeHidden();
 await showMenu();await page.keyboard.press('Escape');await expect(menu).toBeHidden();await expect(page.getByRole('button',{name:'เปิดเมนูทั้งหมด'})).toBeFocused();
 await page.setViewportSize({width:844,height:390});await move('/app/radio');expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(0);await expect(page.locator('.atlas-header')).toBeVisible();if(process.env.ADMIN_SHOTS_DIR)await page.screenshot({path:`${process.env.ADMIN_SHOTS_DIR}/atlas-landscape-radio.png`});
 await page.setViewportSize({width:320,height:640});await move('/app/settings');expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(0);
 await showMenu();await menu.getByRole('switch').click();await page.keyboard.press('Escape');await expect(page.locator('.explorer-ui')).toHaveAttribute('data-explorer-look','dark');
 if(process.env.ADMIN_SHOTS_DIR)await page.screenshot({path:`${process.env.ADMIN_SHOTS_DIR}/atlas-320-dark-settings.png`});
 for(const path of ['/login','/register','/recover']){await page.goto(`${stack.base}${path}`);await expect(page.locator('.atlas-auth .auth')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(0);if(process.env.ADMIN_SHOTS_DIR)await page.screenshot({path:`${process.env.ADMIN_SHOTS_DIR}/atlas-${path.slice(1)}.png`});}
});
