import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: Number(process.env.VW ?? 1280), height: 900 } });
const shot = (page: Page, name: string) =>
  process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}-${process.env.VW ?? 1280}.png`, fullPage: true }) : Promise.resolve();

test('the alpha numbers page is public and says so when there is not enough data yet', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/metrics');
  await expect(page.getByRole('heading', { name: 'Alpha numbers' })).toBeVisible();
  await expect(page.getByText('Not enough data yet').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Export CSV' })).toHaveAttribute('href', /format=csv/);
  await page.getByRole('button', { name: '90 days' }).click();
  await expect(page.getByRole('button', { name: '90 days' })).toHaveAttribute('aria-pressed', 'true');
  await shot(page, 'metrics-empty');
  expect(errors).toEqual([]);
});
