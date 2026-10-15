import { expect, test } from '@playwright/test';

/**
 * Every card of a size is exactly as tall as every other, and none has its name or rules text cut off, however long they
 * are (game.css, "Fixed slots"). It runs on the dev-only page apps/web/cards.html, which lays out every card at each size
 * it is shown at; playwright.config.ts starts the dev server that serves it. Fails when a card's text is changed to
 * something that no longer fits: shorten it, or add a step to TEXT_STEPS / NAME_STEPS (GameCard.tsx).
 */
test('every card at a size is the same height, with nothing cut off', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:4319/cards.html');
  await page.locator('#board .gcard').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished)));

  const sections = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-cards]')].map((s) => {
    const cards = [...s.querySelectorAll<HTMLElement>('.gcard')];
    const heights = cards.map((c) => c.getBoundingClientRect().height);
    const name = (c: Element) => c.querySelector('.gc-name')!.textContent!;
    const cutOff = cards.flatMap((c) => ['.gc-name', '.gc-text', '.gc-kw']
      .filter((sel) => { const e = c.querySelector<HTMLElement>(sel); return !!e && e.scrollHeight > e.clientHeight + 1; })
      .map((sel) => `${name(c)} (${sel})`));
    const fonts = (sel: string) => cards.map((c) => c.querySelector<HTMLElement>(sel)).filter((e) => e && e.clientHeight > 0).map((e) => parseFloat(getComputedStyle(e!).fontSize));
    return { id: s.id, n: cards.length, spread: Math.max(...heights) - Math.min(...heights), cutOff, minText: Math.min(...fonts('.gc-text')), minName: Math.min(...fonts('.gc-name')) };
  }));

  expect(sections.map((s) => s.id)).toEqual(['grid-104', 'grid-111', 'grid-128', 'grid-138', 'grid-150', 'hand', 'compact-hand', 'compact-replay-hand', 'board', 'mini']);
  for (const s of sections) {
    expect(s.n, `${s.id}: cards`).toBeGreaterThan(100);
    expect(s.spread, `${s.id}: tallest minus shortest card (px)`).toBeLessThanOrEqual(0.5);
    expect(s.cutOff, `${s.id}: cut-off text`).toEqual([]);
  }
  // Shrinking has a floor: the smallest rules text on the narrowest phone grid, and the smallest name anywhere.
  expect(sections.find((s) => s.id === 'grid-104')!.minText, 'smallest rules text at 104 px').toBeGreaterThanOrEqual(6);
  expect(Math.min(...sections.map((s) => s.minName)), 'smallest name').toBeGreaterThanOrEqual(9);
  expect(errors).toEqual([]);
});
