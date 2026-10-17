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
    await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished)));

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
    expect(tags).toHaveLength(5);
    expect(tags.filter((t) => t.covered)).toEqual([]);
    expect(errors).toEqual([]);
  });
}
