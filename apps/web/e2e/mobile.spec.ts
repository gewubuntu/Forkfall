import { devices, expect, test, type Page } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { installTestWallet } from './wallet.ts';

const HUB_CHAIN = 84532;

/** Phone emulation in Chromium (the device's own browser engine is a real-device check, see the PR notes). */
const phone = (name: 'Pixel 7' | 'iPhone SE' | 'iPhone SE (3rd gen)' | 'Pixel 7 landscape' | 'iPad Mini') => {
  const d = devices[name];
  return { viewport: d.viewport, userAgent: d.userAgent, deviceScaleFactor: d.deviceScaleFactor, isMobile: true, hasTouch: true };
};

async function signIn(page: Page) {
  await page.getByRole('button', { name: 'Connect wallet' }).first().tap();
  await page.getByRole('button', { name: /Forkfall Test Wallet/ }).tap();
  await page.getByRole('button', { name: 'Sign in with wallet' }).tap();
  await expect(page.getByRole('button', { name: /vs bot/ })).toBeVisible();
}

/** Every part of the board a player needs is on screen at once, and nothing scrolls sideways. */
async function expectBoardFits(page: Page) {
  const m = await page.evaluate(() => {
    const box = (sel: string) => { const r = document.querySelector(sel)!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
    return {
      scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight, w: innerWidth, h: innerHeight,
      parts: ['.side.opp .lane', '.side.opp .treasury', '.turnbar', '.side.me .lane', '.side.me .treasury', '.hand'].map((s) => [s, box(s)] as const),
      small: [...document.querySelectorAll<HTMLElement>('.arena button, .arena a, .arena [role=button]')]
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && !e.closest('.hand') && (r.width < 44 || r.height < 44); })
        .map((e) => e.getAttribute('aria-label') ?? e.textContent),
    };
  });
  expect(m.scrollW).toBe(m.w);
  expect(m.scrollH).toBe(m.h);
  for (const [sel, r] of m.parts) {
    expect(r.top, `${sel} top`).toBeGreaterThanOrEqual(0);
    expect(r.bottom, `${sel} bottom`).toBeLessThanOrEqual(m.h);
    expect(r.left, `${sel} left`).toBeGreaterThanOrEqual(0);
    expect(r.right, `${sel} right`).toBeLessThanOrEqual(m.w);
  }
  expect(m.small, 'touch targets under 44 px').toEqual([]);
}

/** Your turn with a card you can afford: end turns (confirming if asked) until there is one. */
async function untilPlayable(page: Page) {
  for (let i = 0; i < 8; i++) {
    await expect(page.locator('.end-turn')).toBeVisible({ timeout: 30_000 });
    if (await page.locator('.hand .gcard.is-playable').count()) return;
    const turn = await page.locator('.tb-left .small').textContent();
    await page.locator('.end-turn').tap();
    const again = page.getByRole('button', { name: 'Tap again to end' });
    if (await again.isVisible()) await again.tap();
    await expect(page.locator('.tb-left .small')).not.toHaveText(turn ?? '', { timeout: 15_000 });
  }
  throw new Error('no playable card in 8 turns');
}

/** A finger held still on an element, through the DevTools protocol (Playwright has no long-press). */
async function longPress(page: Page, selector: string) {
  const b = (await page.locator(selector).first().boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const p = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
  await page.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// iPhone SE (1st gen) is 320×568, stricter than the 360×640 target; the 3rd gen is 375×667.
for (const name of ['iPhone SE', 'iPhone SE (3rd gen)', 'Pixel 7'] as const) {
  test.describe(`${name} portrait`, () => {
    test.use(phone(name));

    test('a match is playable one-handed: board on one screen, tap to arm and play, long-press for details', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await installTestWallet(page, privateKeyToAccount(generatePrivateKey()), HUB_CHAIN);
      await page.goto('/play');
      await signIn(page);
      await page.getByRole('button', { name: /vs bot/ }).tap();
      await page.waitForURL(/\/match\/0x[0-9a-f]{64}/);
      await page.locator('.hand .gcard').first().waitFor();
      // The header and banner give their space to the board on a phone.
      await expect(page.locator('header.header')).toBeHidden();
      await expectBoardFits(page);

      // A turn with a playable card (the bot may start, and an opening hand may be too expensive). Everything below
      // happens in our own turn, so a draw at the start of a turn can't change the hand mid-check.
      await untilPlayable(page);
      const inHand = await page.locator('.hand .gcard').count();
      const gas = () => page.locator('.side.me .gas').getAttribute('aria-label');
      const gasBefore = await gas();

      // Long-press a card we could afford: details open, nothing is played.
      await longPress(page, '.hand .gcard.is-playable');
      await expect(page.getByRole('dialog', { name: /details/ })).toBeVisible();
      await page.getByRole('dialog', { name: /details/ }).getByRole('button', { name: 'Close' }).tap();
      expect(await gas()).toBe(gasBefore);
      expect(await page.locator('.hand .gcard').count()).toBe(inHand);
      // First tap arms the card and shows its rules text; nothing is played yet.
      await page.locator('.hand .gcard.is-playable').first().tap();
      const armed = page.locator('.armed');
      await expect(armed).toBeVisible();
      await page.waitForTimeout(300);
      expect(await page.locator('.hand .gcard').count()).toBe(inHand);
      const textSize = await armed.locator('.armed-text span').evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
      expect(textSize).toBeGreaterThanOrEqual(12);
      // Play commits it (or, for a targeted card, a glowing target does).
      const play = armed.getByRole('button', { name: 'Play' });
      if (await play.isVisible()) await play.tap();
      else await page.locator('.gcard.is-target, .treasury.target').first().tap();
      for (const b of [page.getByRole('button', { name: 'Play normally' }), page.locator('.choice-list .choice').first()]) {
        if (await b.isVisible().catch(() => false)) await b.tap();
      }
      // Spent Gas shows the card was played (the hand may not shrink: some cards draw).
      await expect.poll(gas).not.toBe(gasBefore);
      await expectBoardFits(page);

      // Concede through the ⋯ menu, confirm, and the result fits the screen.
      await page.getByRole('button', { name: 'Match menu' }).tap();
      await page.getByRole('menuitem', { name: 'Concede…' }).tap();
      await page.getByRole('dialog').getByRole('button', { name: 'Concede', exact: true }).tap();
      await expect(page.getByText('Conceded')).toBeVisible();
      const result = await page.locator('.result').boundingBox();
      expect(result!.y).toBeGreaterThanOrEqual(0);
      expect(result!.y + result!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
      expect(errors).toEqual([]);
    });

    test('dragging a hand card and letting go over the hand cancels: nothing is played', async ({ page }) => {
      await installTestWallet(page, privateKeyToAccount(generatePrivateKey()), HUB_CHAIN);
      await page.goto('/play');
      await signIn(page);
      await page.getByRole('button', { name: /vs bot/ }).tap();
      await page.waitForURL(/\/match\//);
      await untilPlayable(page);
      const gas = () => page.locator('.side.me .gas').getAttribute('aria-label');
      const before = { gas: await gas(), hand: await page.locator('.hand .gcard').count() };
      const b = (await page.locator('.hand .gcard.is-playable').first().boundingBox())!;
      const cdp = await page.context().newCDPSession(page);
      const at = (dx: number, dy: number) => [{ x: b.x + b.width / 2 + dx, y: b.y + b.height / 2 + dy }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0, 0) });
      // Out towards the board and back down into the hand, as a player changing their mind would.
      for (const [dx, dy] of [[6, -20], [10, -60], [14, -30], [18, 0]]) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(dx, dy) });
        await page.waitForTimeout(30);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(1500);
      expect(await gas()).toBe(before.gas);
      expect(await page.locator('.hand .gcard').count()).toBe(before.hand);
    });

    test('ending a turn with moves left takes a second tap', async ({ page }) => {
      await installTestWallet(page, privateKeyToAccount(generatePrivateKey()), HUB_CHAIN);
      await page.goto('/play');
      await signIn(page);
      await page.getByRole('button', { name: /vs bot/ }).tap();
      await page.waitForURL(/\/match\//);
      await untilPlayable(page);
      const turn = async () => Number(/Turn (\d+)/.exec((await page.locator('.tb-left .small').textContent()) ?? '')?.[1]);
      const before = await turn();
      await page.locator('.end-turn').tap();
      await expect(page.getByRole('button', { name: 'Tap again to end' })).toBeVisible();
      expect(await turn()).toBe(before);
      await page.getByRole('button', { name: 'Tap again to end' }).tap();
      await expect.poll(turn, { timeout: 15_000 }).toBeGreaterThan(before);
    });

    test('the first lesson plays through with the coach above the board, not over the hand', async ({ page }) => {
      await page.goto('/learn/basics');
      await page.locator('.hand .gcard').first().waitFor();
      const [coach, hand] = await Promise.all([page.locator('.coach').boundingBox(), page.locator('.hand').boundingBox()]);
      expect(coach!.y + coach!.height).toBeLessThanOrEqual(hand!.y);
      expect(hand!.y + hand!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
      for (let i = 0; i < 300; i++) {
        if (await page.getByText('Match over').isVisible()) break;
        for (const n of ['Next', 'Show me', 'End turn']) {
          const b = page.getByRole('button', { name: n, exact: true });
          if (await b.isVisible() && await b.isEnabled()) { await b.tap(); break; }
        }
        await page.waitForTimeout(150);
      }
      await expect(page.getByText('Match over')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()!.width);
    });
  });
}

test.describe('phone browser without a wallet', () => {
  test.use(phone('Pixel 7'));
  test('offers to open the game inside a wallet app, keeping the page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect wallet' }).first().tap();
    const mm = page.getByRole('link', { name: /Open in MetaMask/ });
    await expect(mm).toBeVisible();
    expect(await mm.getAttribute('href')).toBe('https://metamask.app.link/dapp/127.0.0.1:4317/');
    expect(await page.getByRole('link', { name: /Open in Coinbase Wallet/ }).getAttribute('href')).toBe(`https://go.cb-w.com/dapp?cb_url=${encodeURIComponent('http://127.0.0.1:4317/')}`);
  });
});

test.describe('phone in landscape', () => {
  test.use(phone('Pixel 7 landscape'));
  test('the board does not break: nothing scrolls sideways and End turn is reachable', async ({ page }) => {
    await installTestWallet(page, privateKeyToAccount(generatePrivateKey()), HUB_CHAIN);
    await page.goto('/play');
    await signIn(page);
    await page.getByRole('button', { name: /vs bot/ }).tap();
    await page.waitForURL(/\/match\//);
    await expect(page.locator('.end-turn')).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()!.width);
    await page.locator('.end-turn').scrollIntoViewIfNeeded();
    await expect(page.locator('.end-turn')).toBeInViewport();
  });
});

test.describe('tablet (touch, wider than the phone layout)', () => {
  test.use(phone('iPad Mini'));
  test('a picked-up card shows its Play bar unclipped, and Play plays it', async ({ page }) => {
    await installTestWallet(page, privateKeyToAccount(generatePrivateKey()), HUB_CHAIN);
    await page.goto('/play');
    await signIn(page);
    await page.getByRole('button', { name: /vs bot/ }).tap();
    await page.waitForURL(/\/match\//);
    await untilPlayable(page);
    const gas = () => page.locator('.side.me .gas').getAttribute('aria-label');
    const before = await gas();
    await page.locator('.hand .gcard.is-playable').first().tap();
    const armed = page.locator('.armed');
    await expect(armed).toBeInViewport({ ratio: 1 });
    // Not clipped by the scrolling hand: the bar's middle is the topmost element there.
    const box = (await armed.boundingBox())!;
    const topmost = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.armed'), [box.x + box.width / 2, box.y + box.height / 2]);
    expect(topmost).toBe(true);
    const play = armed.getByRole('button', { name: 'Play' });
    if (await play.isVisible()) await play.tap();
    else await page.locator('.gcard.is-target, .treasury.target').first().tap();
    for (const b of [page.getByRole('button', { name: 'Play normally' }), page.locator('.choice-list .choice').first()]) {
      if (await b.isVisible().catch(() => false)) await b.tap();
    }
    await expect.poll(gas).not.toBe(before);
  });
});
