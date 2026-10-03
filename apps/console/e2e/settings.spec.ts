import { ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startApi } from '../test/api-process';
import { CLIENT_ID, CLIENT_SECRET, MockIdp, startMockIdp } from '../test/mock-idp';

// Full browser run: real Next.js build + real services/api + PostgreSQL, with the test-only IdP.
let idp: MockIdp;
let api: { url: string; stop: () => Promise<void> };
let web: ChildProcess;
let base: string;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

test.beforeAll(async () => {
  idp = await startMockIdp();
  api = await startApi(idp.issuer);
  const port = await freePort();
  base = `http://localhost:${port}`;
  web = spawn(join(__dirname, '../node_modules/.bin/next'), ['start', '-p', String(port)], {
    cwd: join(__dirname, '..'),
    stdio: 'ignore',
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
      CONSOLE_BASE_URL: base,
      API_BASE_URL: api.url,
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_CLIENT_SECRET: CLIENT_SECRET,
      SESSION_SECRET: 'e2e-'.repeat(10),
    },
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/login`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

test.afterAll(async () => {
  web?.kill('SIGTERM');
  await api?.stop();
  await idp?.close();
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
  await expect(page.getByText('รอซิงก์')).toBeVisible();

  await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
  await expect(page).toHaveURL(`${base}/login?signedOut=1`);
  await expect(page.getByText('ออกจากระบบแล้ว')).toBeVisible();
  await page.goto(`${base}/app/settings`);
  await expect(page).toHaveURL(/\/login/);
});
