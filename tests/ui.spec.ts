import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
test('console supports create, claim, update, private notes, search and responsive layout', async ({
  page,
}, info) => {
  const subject =
    info.project.name === 'desktop'
      ? 'Intermittent connection to the workspace API'
      : 'Mobile session expires before sign-in completes';
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (process.env.SCREENSHOTS) await page.setViewportSize({ width: 1440, height: 1320 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/support/');
  await expect(page.getByRole('heading', { name: 'Every case. Under control.' })).toBeVisible();
  await expect(page.locator('#cases tr')).toHaveCount(8);
  if (process.env.SCREENSHOTS && info.project.name === 'desktop') {
    await mkdir('docs/screenshots', { recursive: true });
    await page.screenshot({ path: 'docs/screenshots/dashboard.png', fullPage: false });
  }
  await expect(page.locator('#brand')).toHaveText('CookieCaseKit');
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('#cases tr')).toHaveCount(8);
  if (process.env.SCREENSHOTS && info.project.name === 'desktop')
    await page.screenshot({ path: 'docs/screenshots/dashboard-dark.png', fullPage: false });
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  await page.getByRole('button', { name: 'New case' }).click();
  await page.getByLabel('Subject', { exact: true }).fill(subject);
  await page
    .getByLabel('Description', { exact: true })
    .fill('Created through the real support console.');
  await page.locator('#create-priority').selectOption('high');
  await page.getByRole('button', { name: 'Create case →' }).click();
  await expect(page.locator('#detail-dialog')).toBeVisible();
  await expect(page.locator('#detail-title')).toHaveText(subject);
  await page.getByRole('button', { name: 'Assign to me' }).click();
  await expect(page.locator('#detail-meta')).toContainText('Assigned: alex');
  await page.locator('#detail-status').selectOption('in_progress');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('#detail-meta .badge')).toHaveText('In progress');
  await page.getByLabel('Write a reply').fill('Investigating the request with the platform team.');
  await page.getByLabel('Internal note').check();
  await page.getByRole('button', { name: 'Send reply →' }).click();
  await expect(page.locator('.comment.internal')).toContainText('Investigating the request');
  await page.getByLabel('Write a reply').fill('Thanks for reaching out. We are working on a fix.');
  await page.getByRole('button', { name: 'Send reply →' }).click();
  await expect(page.locator('#comments .comment')).toHaveCount(2);
  if (process.env.SCREENSHOTS && info.project.name === 'desktop')
    await page.screenshot({ path: 'docs/screenshots/case-detail.png', fullPage: false });
  await page.locator('#detail-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await page.getByRole('button', { name: subject, exact: true }).click();
  await expect(page.locator('#detail-dialog')).toBeVisible();
  await expect(page.locator('#detail-dialog')).toHaveCSS('background-color', 'rgb(28, 40, 33)');
  await expect(page.locator('#comment-body')).toHaveCSS('background-color', 'rgb(36, 51, 41)');
  if (process.env.SCREENSHOTS && info.project.name === 'desktop')
    await page.screenshot({ path: 'docs/screenshots/case-detail-dark.png', fullPage: false });
  await page.locator('#detail-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search cases' }).fill(subject);
  await expect(page.locator('#cases tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Assigned to me', exact: false }).click();
  await expect(page.locator('#cases tr')).toHaveCount(1);
  await page.getByLabel('Filter by priority').selectOption('low');
  await expect(page.locator('#empty')).toBeVisible();
  expect(errors).toEqual([]);
});
