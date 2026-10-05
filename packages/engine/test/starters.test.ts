import { describe, expect, it } from 'vitest';
import { card, COLLECTIBLE, RACES, randomRankedDeck, setOf, STARTER_CARDS, starterDeck, validateDeck } from '../src/index.ts';

describe('starter decks', () => {
  it('are 30 ranked-legal cards: 2 of each of 15, race cards and core neutrals, no Legendary or collab card', () => {
    for (const race of RACES) {
      const deck = starterDeck(race);
      expect(deck).toHaveLength(30);
      expect(validateDeck(race, deck, true)).toMatchObject({ ok: true });
      expect(new Set(STARTER_CARDS[race]).size).toBe(15);
      for (const id of STARTER_CARDS[race]) {
        const c = card(id);
        expect([race, 'neutral']).toContain(c.faction);
        expect(c.rarity).not.toBe('legendary');
        expect(setOf(c)).toBe('core');
      }
    }
  });

  it('stay as minted when new cards join the set', () => {
    // Every starter card is one of the prototype's first 40; anything added later is not in a starter.
    const later = COLLECTIBLE.filter((c) => c.id > 40).map((c) => c.id);
    for (const race of RACES) expect(starterDeck(race).filter((id) => later.includes(id))).toEqual([]);
  });
});

describe('randomRankedDeck', () => {
  it('builds a ranked-legal deck from the race pool, the same for the same seed', () => {
    for (const race of RACES) {
      const seen = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const deck = randomRankedDeck(race, String(i));
        expect(validateDeck(race, deck, true), `${race} ${i}`).toMatchObject({ ok: true });
        expect(deck.every((id) => setOf(id) === 'core')).toBe(true);
        expect(randomRankedDeck(race, String(i))).toEqual(deck);
        seen.add(deck.join());
      }
      expect(seen.size).toBeGreaterThan(1); // the seed matters
    }
  });
});
