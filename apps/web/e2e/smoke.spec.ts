import { expect, test, type Page } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { installTestWallet } from './wallet.ts';

const HUB_CHAIN = 84532; // the off-chain referee signs for Base Sepolia by default

/**
 * On /play: connect the injected test wallet and sign in (one SIWE signature authorizes the in-browser session key).
 * Waits for the Play page itself: the sign-in button is relabelled the moment sign-in starts, long before it ends.
 */
async function signIn(page: Page) {
  await page.getByRole('button', { name: 'Connect wallet' }).first().click();
  await page.getByRole('button', { name: /Forkfall Test Wallet/ }).click();
  await page.getByRole('button', { name: 'Sign in with wallet' }).click();
  await expect(page.getByRole('button', { name: /vs bot/ })).toBeVisible();
}

test('the tutorial plays to the end without a wallet', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/learn/basics');
  for (let i = 0; i < 300; i++) {
    if (await page.getByText('Match over').isVisible()) break;
    for (const name of ['Next', 'Show me', 'End turn']) {
      const b = page.getByRole('button', { name, exact: true });
      if (await b.isVisible() && await b.isEnabled()) { await b.click(); break; }
    }
    await page.waitForTimeout(150);
  }
  await expect(page.getByText('Match over')).toBeVisible();
  expect(errors).toEqual([]);
});

test('sign in with a browser wallet, play the house bot, sign the result and verify the replay', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = await installTestWallet(page, account, HUB_CHAIN);

  await page.goto('/play');
  await signIn(page);
  expect(wallet.signed).toEqual(['personal_sign']); // the one wallet signature for the session

  // Practice is the default tab; start a match against the bot.
  await page.getByRole('button', { name: /vs bot/ }).click();
  await page.waitForURL(/\/match\/0x[0-9a-f]{64}/);
  const matchId = page.url().split('/match/')[1];

  // Play two turns (each move is signed silently by the session key), then concede.
  for (let turns = 0; turns < 2;) {
    const end = page.getByRole('button', { name: 'End turn' });
    await end.waitFor({ state: 'visible', timeout: 30_000 });
    await end.click();
    await expect(end).toBeHidden();
    turns++;
  }
  await page.getByRole('button', { name: 'Concede', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Concede', exact: true }).click();
  await expect(page.getByText('Conceded')).toBeVisible();

  // Match results are signed by the wallet itself (EIP-712), not the session key.
  await page.getByRole('button', { name: 'Sign result' }).click();
  await expect(page.getByText(/Both players signed/)).toBeVisible();
  expect(wallet.signed).toEqual(['personal_sign', 'eth_signTypedData_v4']);

  // The replay re-runs the public log in the browser and checks every signature.
  await page.goto(`/matches/${matchId}`);
  const verify = page.locator('.verify');
  await expect(verify.getByText('Seed reveals match both commitments')).toBeVisible();
  await expect(verify.locator('li.ok')).toHaveCount(4);
  await expect(verify.locator('li.bad')).toHaveCount(0);
  await expect(verify.getByText(/moves signed by the player or their session key/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('a session survives a reload without asking the wallet again', async ({ page }) => {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = await installTestWallet(page, account, HUB_CHAIN);
  await page.goto('/play');
  await signIn(page);
  await page.reload();
  await expect(page.getByRole('button', { name: /vs bot/ })).toBeVisible();
  expect(wallet.signed).toEqual(['personal_sign']);
});

test('a concede lands even when the page lags behind the bot', async ({ page }) => {
  const account = privateKeyToAccount(generatePrivateKey());
  await installTestWallet(page, account, HUB_CHAIN);
  await page.goto('/play');
  await signIn(page);
  await page.getByRole('button', { name: /vs bot/ }).click();
  await page.waitForURL(/\/match\/0x[0-9a-f]{64}/);
  // A slow connection: the event log arrives 1.5 s late, so the board view trails the bot's moves.
  await page.route(/\/events/, async (r) => { await new Promise((x) => setTimeout(x, 1500)); await r.continue(); });
  const end = page.getByRole('button', { name: 'End turn' });
  await end.click();
  await expect(end).toBeHidden();
  // Concede in the bot's turn, before this page has caught up with its moves.
  await page.getByRole('button', { name: 'Concede', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Concede', exact: true }).click();
  await expect(page.getByText('Conceded')).toBeVisible();
});
