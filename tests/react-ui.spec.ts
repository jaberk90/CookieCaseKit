import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('native React console embeds in a host page and uses the session identity', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('http://127.0.0.1:3101/support');
  const kit = page.getByRole('region', { name: 'CookieCaseKit support console' });
  await expect(kit.getByRole('heading', { name: 'Every case. Under control.' })).toBeVisible();
  await expect(kit.locator('.profile')).toContainText('Jordan Admin');
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.locator('#host-button')).toHaveCSS('background-color', 'rgb(220, 232, 255)');
  await expect(
    kit.getByRole('button', { name: 'Question from our website contact form', exact: true }),
  ).toBeVisible();
  if (process.env.REACT_SCREENSHOTS && info.project.name === 'desktop') {
    await mkdir('docs/screenshots', { recursive: true });
    await page.screenshot({ path: 'docs/screenshots/react-embed.png', fullPage: true });
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  const title = `React request ${info.project.name}`;
  await kit.getByRole('button', { name: 'New case' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Subject', { exact: true }).fill(title);
  await dialog
    .getByLabel('Description', { exact: true })
    .fill('Created inside our own React support page.');
  await dialog.getByRole('button', { name: 'Create case →' }).click();
  await expect(dialog).toHaveAttribute('aria-labelledby', /.+/);
  await expect(dialog.getByRole('heading', { name: title })).toBeVisible();
  await dialog.getByRole('button', { name: 'Assign to me' }).click();
  await expect(dialog.locator('.detail-meta')).toContainText('Assigned: react-admin');
  await dialog.getByRole('combobox', { name: 'Status', exact: true }).selectOption('in_progress');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.locator('.badge')).toHaveText('In progress');
  await dialog.getByLabel('Write a reply').fill('Reviewing the website request.');
  await dialog.getByLabel('Internal note').check();
  await dialog.getByRole('button', { name: 'Send reply →' }).click();
  await expect(dialog.locator('.comment.internal')).toContainText('Reviewing the website request.');
  await expect(dialog.locator('.comment.internal')).toContainText('Jordan Admin');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await kit.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(kit).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(kit).toHaveAttribute('data-theme', 'dark');
  await kit.getByRole('searchbox', { name: 'Search cases' }).fill(title);
  await expect(kit.locator('tbody tr')).toHaveCount(1);
  await kit.getByRole('button', { name: title, exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS('background-color', 'rgb(28, 40, 33)');
  expect(errors).toEqual([]);
});

test('React cannot grant access when the backend session is unauthorized', async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: 'demo-support', value: 'denied', url: 'http://127.0.0.1:3101' },
  ]);
  await page.goto('http://127.0.0.1:3101/support');
  await expect(page.getByRole('alert')).toContainText(
    'Sign in with an account that has support access',
  );
  await expect(page.getByRole('button', { name: 'New case' })).toHaveCount(0);
  expect((await page.request.get('http://127.0.0.1:3101/_casekit/api/cases')).status()).toBe(401);
});
