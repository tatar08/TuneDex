import { expect, test } from '@playwright/test';
import { THEMES } from '../src/lib/admin';
import { startStack, Stack } from './stack';

// Doc 17: every staff page reads in English when the viewer picks English, in every theme.
let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack();
  for (const role of ['admin', 'operator', 'auditor', 'support', 'catalog_editor']) {
    stack.api.staff('grant', 'e2e-en', role, '--by', 'e2e', '--reason', 'test');
  }
});

test.afterAll(async () => {
  await stack?.stop();
});

const PAGES = ['/admin/overview', '/admin/stations', '/admin/stations/new', '/admin/config', '/admin/jobs', '/admin/users', '/admin/audit', '/admin/logs'];
// The switch back to Thai is labelled in Thai on purpose.
const ALWAYS_THAI = ['ภาษาไทย'];
const THAI = /[฀-๿]+/g;

test('every staff page has no Thai left in English, in all five themes', async ({ browser }) => {
  stack.idp.setUser('e2e-en');
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${stack.base}/auth/login?returnTo=${encodeURIComponent('/admin/overview')}`);
  await expect(page).toHaveURL(`${stack.base}/admin/overview`);

  // Switching language from the console comes back to the same page.
  await page.getByRole('link', { name: 'English' }).click();
  await expect(page).toHaveURL(`${stack.base}/admin/overview`);
  await expect(page.getByRole('link', { name: 'ภาษาไทย' })).toBeVisible();

  const host = new URL(stack.base).hostname;
  const leftovers: string[] = [];
  for (const theme of THEMES) {
    await context.addCookies([{ name: 'td_admin_theme', value: theme.id, domain: host, path: '/admin' }]);
    for (const path of PAGES) {
      await page.goto(`${stack.base}${path}`);
      await expect(page.locator(`[data-theme-id="${theme.id}"]`)).toBeVisible();
      const text = await page.locator('body').innerText();
      const titles = await page.$$eval('[title],[aria-label],[placeholder]', (els) =>
        els.flatMap((e) => ['title', 'aria-label', 'placeholder'].map((a) => e.getAttribute(a) ?? '')),
      );
      let rest = [text, ...titles].join('\n');
      for (const ok of ALWAYS_THAI) rest = rest.split(ok).join('');
      for (const m of rest.match(THAI) ?? []) leftovers.push(`${theme.id} ${path}: ${m}`);
    }
  }
  expect([...new Set(leftovers)]).toEqual([]);
});
