import { expect, test, type Page } from '@playwright/test';

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe.configure({ mode: 'serial' });

test('home composer fits the phone, menu opens every page without sideways scrolling', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'What do you want to find out?' })).toBeVisible();
  await expect(page.locator('#homeNotice')).toContainText('Demo mode');
  await noSideScroll(page);
  for (const name of ['History', 'Setup & keys', 'Guide']) {
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.locator('#sidebar .navlink', { hasText: name }).click();
    await expect(page.locator('.view.on h1')).toBeVisible();
    await expect(page.locator('#sidebar')).not.toHaveClass(/\bon\b/);
    await noSideScroll(page);
  }
});

test('builds a tree, opens a piece as a sheet, chats in it, runs, and finds it in History', async ({ page }) => {
  await page.goto('/');
  await page.locator('#inQuestion').fill('cars to sell 2000-4000 from DE to CZ profitable 15% min, trend detected');
  await page.locator('#inExpected').fill('5 links to real listings priced 2000-4000 EUR');
  await page.getByRole('button', { name: 'Build the tree →' }).click();
  await expect(page.locator('#outline .orow')).toHaveCount(13, { timeout: 30000 });
  await noSideScroll(page);

  await page.locator('#outline .orow[data-node="D1"]').click();
  await expect(page.locator('#inspector')).toHaveClass(/\bon\b/);
  await expect(page.locator('#inspBody h2')).toBeVisible();
  await page.locator('#inspTabs button[data-mode="chat"]').click();
  const input = page.locator('#chatIn');
  await expect(input).toBeVisible();
  await expect(page.locator('#chatTitle')).toContainText('D1');
  await input.fill('what is missing here?');
  await page.waitForTimeout(1200);
  await expect(input).toHaveValue('what is missing here?');
  await page.locator('#chatSend').click();
  await expect(page.locator('#chatMsgs .msg.user')).toHaveCount(1);
  await expect(page.locator('#chatMsgs .msg.user')).toContainText('what is missing here?');
  await expect(page.locator('#chatMsgs .msg.assistant').last()).toContainText('DEMO assistant', { timeout: 20000 });
  await expect(input).toHaveValue('');
  await page.locator('#chatScopes button[data-scope="app"]').click();
  await expect(page.locator('#chatTitle')).toContainText('Whole application');
  await input.fill('which research is furthest along?');
  await page.locator('#chatSend').click();
  await expect(page.locator('#chatMsgs .msg.assistant').last()).toContainText('DEMO app assistant', { timeout: 20000 });
  await page.locator('#chatScopes button[data-scope="node"]').click();
  await expect(page.locator('#chatMsgs .msg.user')).toContainText('what is missing here?');

  await page.locator('#inspTabs button[data-mode="details"]').click();
  await page.locator('#fileIn').setInputFiles({ name: 'prices.csv', mimeType: 'text/csv', buffer: Buffer.from('model,price\nGolf,2500\nPolo,3100\n') });
  await expect(page.locator('.file .n')).toHaveText('prices.csv', { timeout: 10000 });
  await noSideScroll(page);
  await page.getByRole('button', { name: 'Close panel' }).click();
  await expect(page.locator('#inspector')).not.toHaveClass(/\bon\b/);

  await page.locator('#btnRun').click();
  await page.locator('.tabs .tab', { hasText: 'Report' }).click();
  await expect(page.locator('#reportBody .verdict')).toContainText('GO-IF', { timeout: 40000 });
  await noSideScroll(page);

  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.locator('#projList .pitem').first()).toContainText('cars to sell 2000-4000');
  await page.locator('#sidebar .navlink', { hasText: 'History' }).click();
  await expect(page.locator('#histProjects')).toContainText('cars to sell 2000-4000');
  await noSideScroll(page);
});
