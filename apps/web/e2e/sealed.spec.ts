import { expect, test, type Page } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { installTestWallet } from './wallet.ts';

const HUB_CHAIN = 84532;
// SHOTS=<dir> VW=<width>: also save screenshots of each Sealed screen (for pull requests).
test.use({ viewport: { width: Number(process.env.VW ?? 1280), height: 900 } });
const shot = (page: Page, name: string, fullPage = false) =>
  process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}-${process.env.VW ?? 1280}.png`, fullPage }) : Promise.resolve();

test('Sealed: open the packs, build a deck, get matched with the house bot, play and see the record and proof', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await installTestWallet(page, privateKeyToAccount(generatePrivateKey()), HUB_CHAIN);

  await page.goto('/play');
  await page.getByRole('button', { name: 'Connect wallet' }).first().click();
  await page.getByRole('button', { name: /Forkfall Test Wallet/ }).click();
  await page.getByRole('button', { name: 'Sign in with wallet' }).click();
  await shot(page, 'play-banner');
  await page.getByRole('link', { name: /Sealed/ }).first().click();

  await expect(page.getByRole('heading', { name: 'Start today’s free run' })).toBeVisible();
  await shot(page, 'sealed-start');
  await page.getByRole('button', { name: 'Start run' }).click();
  await shot(page, 'sealed-packs');

  await expect(page.getByText('Your 6 packs are sealed')).toBeVisible();
  await page.getByRole('button', { name: 'Skip the animations' }).click();
  await page.getByRole('button', { name: 'Build for me' }).click();
  await expect(page.getByText('30/30')).toBeVisible();
  await page.getByRole('button', { name: 'Save deck' }).click();
  await expect(page.getByRole('button', { name: 'Deck saved' })).toBeVisible();
  await shot(page, 'sealed-build', true);

  await page.getByRole('button', { name: 'Find a match' }).click();
  await expect(page.getByText(/you’ll play a house bot|Matching you with a house bot/)).toBeVisible();
  await shot(page, 'sealed-queue');
  await page.waitForURL(/\/match\/0x[0-9a-f]{64}/, { timeout: 20_000 });

  await page.getByRole('button', { name: 'Concede', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Concede', exact: true }).click();
  await expect(page.getByText('Conceded')).toBeVisible();

  await page.goto('/sealed');
  await expect(page.getByRole('img', { name: '0 wins, 1 losses' }).first()).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'End run' }).click();
  await page.getByRole('button', { name: 'Verify pool' }).click();
  await expect(page.getByText(/the pool was rolled from the committed seed/)).toBeVisible();
  await shot(page, 'sealed-history');
  expect(errors).toEqual([]);
});
