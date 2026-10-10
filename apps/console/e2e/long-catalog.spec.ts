import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { registerBrowserCleanup, startStack, Stack } from './stack';

registerBrowserCleanup();

let stack: Stack;

const station = {
  name: 'Zulu Needle FM',
  country: 'TH',
  language: 'th',
  genres: ['jazz'],
  streamUrl: 'https://stream.example.com/needle.mp3',
  codec: 'mp3',
  bitrateKbps: 128,
};

test.beforeAll(async () => {
  stack = await startStack();
  stack.api.staff('grant', 'e2e-long-editor', 'catalog_editor', '--by', 'e2e', '--reason', 'test');
  const res = await fetch(`${stack.api.url}/v1/admin/stations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await stack.idp.accessTokenFor('e2e-long-editor')}` },
    body: JSON.stringify(station),
  });
  expect(res.status).toBe(201);
  const { id } = await res.json();
  // 2,050 copies named "Bulk 0001"… sort before the original, so it falls past the console's 2,000-station read.
  const pool = new Pool({ connectionString: stack.api.databaseUrl });
  await pool.query(
    `INSERT INTO radio_stations (draft, created_by, updated_by, pending_authors)
     SELECT jsonb_set(draft, '{name}', to_jsonb('Bulk ' || lpad(g::text, 4, '0'))), created_by, updated_by, pending_authors
       FROM radio_stations, generate_series(1, 2050) g WHERE id = $1`,
    [id],
  );
  await pool.end();
});

test.afterAll(async () => {
  await stack?.stop();
});

test('a catalog longer than the console reads still finds every station by a server search', async ({ browser }) => {
  stack.idp.setUser('e2e-long-editor');
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  await page.goto(`${stack.base}/auth/login?returnTo=${encodeURIComponent('/admin/stations')}`);
  await expect(page).toHaveURL(`${stack.base}/admin/stations`);

  const note = page.locator('.adm-note');
  await expect(note).toContainText('2,000');
  await expect(page.getByRole('link', { name: 'Zulu Needle FM' })).toHaveCount(0);

  await note.getByRole('searchbox').fill('needle');
  await note.getByRole('button').click();
  await expect(page).toHaveURL(`${stack.base}/admin/stations?q=needle`);
  await expect(page.locator('.adm-note')).toContainText('needle');
  await expect(page.getByRole('link', { name: 'Zulu Needle FM' }).first()).toBeVisible();

  await page.locator('.adm-note').getByRole('link').click();
  await expect(page).toHaveURL(`${stack.base}/admin/stations`);
});
