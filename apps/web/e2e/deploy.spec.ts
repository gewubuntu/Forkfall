import { expect, test } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { installTestWallet } from './wallet.ts';

/**
 * A tab that outlived a deploy asks for a page chunk the server no longer has. The app reloads into the new build
 * once instead of going blank.
 */
test('a page chunk missing after a deploy reloads into the new build instead of a blank screen', async ({ page }) => {
  await installTestWallet(page, privateKeyToAccount(generatePrivateKey()), 84532);
  await page.goto('/play');
  await page.getByRole('button', { name: 'Connect wallet' }).first().click();
  await page.getByRole('button', { name: /Forkfall Test Wallet/ }).click();
  await page.getByRole('button', { name: 'Sign in with wallet' }).click();
  await expect(page.getByRole('button', { name: /vs bot/ })).toBeVisible();

  // The first request for the Matches page's chunk 404s, as for a build the server has replaced.
  let failed = 0;
  await page.route(/\/assets\/Matches-[^/]+\.js$/, async (r) => {
    if (failed++ === 0) await r.fulfill({ status: 404, body: '{"error":"not found"}', contentType: 'application/json' });
    else await r.continue();
  });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Matches' }).click();
  await expect(page.getByRole('heading', { name: 'Matches', level: 1 })).toBeVisible();
  expect(failed).toBeGreaterThanOrEqual(2); // failed once, then loaded after the reload
});

test('a deep link starts its page chunks before the stylesheet has loaded', async ({ request }) => {
  const html = await (await request.get('/challenge/abc')).text();
  const preload = html.indexOf("l.rel='modulepreload'");
  const css = html.search(/<link rel="stylesheet"/);
  expect(preload).toBeGreaterThan(0);
  expect(css).toBeGreaterThan(0);
  // An inline script after a stylesheet <link> waits for the CSS, which held the preloads back a round trip.
  expect(preload).toBeLessThan(css);
  // ...and it doesn't push <meta charset> out of the first 1024 bytes, where browsers look for it.
  expect(html.indexOf('<meta charset')).toBeLessThan(1024);
});
