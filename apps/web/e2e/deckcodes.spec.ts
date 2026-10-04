import { decodeDeck, encodeDeck, starterDeck } from '@forkfall/engine';
import { expect, test } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { installTestWallet } from './wallet.ts';

test('a deck code opens in the builder, copies back out, and a damaged one is refused', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await installTestWallet(page, privateKeyToAccount(generatePrivateKey()), 84532);
  await page.goto('/play');
  await page.getByRole('button', { name: 'Connect wallet' }).first().click();
  await page.getByRole('button', { name: /Forkfall Test Wallet/ }).click();
  await page.getByRole('button', { name: 'Sign in with wallet' }).click();
  await expect(page.getByRole('button', { name: /vs bot/ })).toBeVisible();

  // A shared link opens the deck: race switched, all 30 cards listed.
  const deck = starterDeck('prophets');
  const code = encodeDeck('prophets', deck);
  await page.goto(`/decks/new?code=${code}`);
  await expect(page.getByRole('radio', { name: 'Prophets' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('meter', { name: 'Cards' })).toHaveAttribute('aria-valuenow', '30');
  await expect(page.getByLabel('Deck name')).toHaveValue('Imported Prophets deck');

  // Edit it and copy the code back out: it decodes to the edited list.
  const first = page.locator('.deck-list li').first();
  await first.getByRole('button', { name: /Remove one/ }).click();
  await page.getByRole('button', { name: 'Copy deck code' }).click();
  await expect(page.getByRole('button', { name: 'Deck code copied ✓' })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(decodeDeck(copied).cards).toHaveLength(29);

  // Pasting a damaged code shows why and keeps the current list.
  await page.getByRole('button', { name: 'Import code' }).click();
  await page.getByLabel('Deck code').fill(code.slice(0, -3));
  await page.getByRole('button', { name: 'Open deck' }).click();
  await expect(page.getByRole('alert')).toContainText('damaged');
  await expect(page.getByRole('meter', { name: 'Cards' })).toHaveAttribute('aria-valuenow', '29');
  // Closing the form clears the error; reopening it starts clean.
  await page.getByRole('button', { name: 'Import code' }).click();
  await expect(page.getByRole('alert')).toBeHidden();
  await page.getByRole('button', { name: 'Import code' }).click();

  // A whole pasted post works: the code is found inside it.
  await page.getByLabel('Deck code').fill(`try my degens list ${encodeDeck('degens', starterDeck('degens'))} 🚀`);
  await page.getByRole('button', { name: 'Open deck' }).click();
  await expect(page.getByRole('radio', { name: 'Degens' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('meter', { name: 'Cards' })).toHaveAttribute('aria-valuenow', '30');
  expect(errors).toEqual([]);
});

test('where the clipboard is blocked, the code is shown to copy by hand', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('blocked')) } });
  });
  const code = encodeDeck('brokers', starterDeck('brokers'));
  await installTestWallet(page, privateKeyToAccount(generatePrivateKey()), 84532);
  await page.goto('/play');
  await page.getByRole('button', { name: 'Connect wallet' }).first().click();
  await page.getByRole('button', { name: /Forkfall Test Wallet/ }).click();
  await page.getByRole('button', { name: 'Sign in with wallet' }).click();
  await expect(page.getByRole('button', { name: /vs bot/ })).toBeVisible();
  await page.goto(`/decks/new?code=${code}`);
  await expect(page.getByRole('meter', { name: 'Cards' })).toHaveAttribute('aria-valuenow', '30');
  const shown: { type: string; value: string }[] = [];
  page.on('dialog', (d) => { shown.push({ type: d.type(), value: d.defaultValue() }); void d.dismiss(); });
  await page.getByRole('button', { name: 'Copy deck code' }).click();
  await expect.poll(() => shown).toEqual([{ type: 'prompt', value: code }]);
  await expect(page.getByRole('button', { name: 'Copy deck code' })).toBeVisible(); // not "copied"
});
