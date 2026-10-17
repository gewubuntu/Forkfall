import { expect, test } from '@playwright/test';

/**
 * In the pack reveal every card's rarity label (under the card) is not covered by another card, which is what happened
 * on a phone where the five cards wrap to two rows, and the page scrolls so that the title and buttons are reachable on a
 * short screen (the buttons are clicked, which fails when they are cut off). It runs on the dev-only page apps/web/reveal.html
 * (see cards.spec.ts for how it is served).
 */
for (const [name, width, height] of [['desktop', 1280, 800], ['phone', 390, 844], ['phone 375', 375, 667], ['small phone', 320, 568]] as const) {
  test(`pack reveal: rarity labels are not covered (${name})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width, height });
    await page.goto('http://127.0.0.1:4319/reveal.html');
    await page.getByRole('button', { name: 'Tear the pack open' }).click({ force: true });
    await page.getByRole('button', { name: 'Reveal all' }).click();
    await page.getByRole('button', { name: 'Add to collection' }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity).length)).toBe(0);

    // Geometry, not hit-testing, so it holds however the page is scrolled: the label must not overlap any other card.
    const tags = await page.evaluate(() => {
      const cards = [...document.querySelectorAll<HTMLElement>('.flip')];
      return [...document.querySelectorAll<HTMLElement>('.rarity-tag')].map((t, i) => {
        const r = t.getBoundingClientRect();
        const covered = cards.filter((c, j) => {
          const b = c.getBoundingClientRect();
          return j !== i && r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top;
        }).length;
        return { text: t.textContent, covered };
      });
    });
    // The canvas (particles) and the flash/banner are fixed to the screen, however far the reveal is scrolled.
    await page.locator('.reveal-scroll').evaluate((e) => { e.scrollTop = e.scrollHeight; });
    const fx = await page.evaluate(() => [...document.querySelectorAll('.particles, .legend-flash, .legend-banner')].map((e) => ({ cls: e.className, top: Math.round(e.getBoundingClientRect().top) })));
    expect(fx.filter((e) => e.cls.includes('particles'))).toEqual([{ cls: 'particles', top: 0 }]);
    expect(fx.filter((e) => e.top < 0)).toEqual([]);
    expect(tags).toHaveLength(5);
    expect(tags.filter((t) => t.covered)).toEqual([]);
    expect(errors).toEqual([]);
  });
}
