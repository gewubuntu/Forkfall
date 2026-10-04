import { describe, expect, it } from 'vitest';
import { COLLECTIBLE, DeckCodeError, decodeDeck, encodeDeck, RACES, starterDeck, type Race } from '../src/index.ts';

const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);
/** A legal 30-card deck: the starter list with its race's Legendary swapped in. */
function withLegendary(race: Race) {
  const legend = COLLECTIBLE.find((c) => c.faction === race && c.rarity === 'legendary')!;
  return [...starterDeck(race).slice(1), legend.id];
}

describe('deck codes', () => {
  it('round-trip every starter deck and a deck with a Legendary, in about 30 characters', () => {
    for (const race of RACES) {
      for (const deck of [starterDeck(race), withLegendary(race)]) {
        const code = encodeDeck(race, deck);
        expect(code).toMatch(/^FF[A-Za-z0-9_-]+$/);
        expect(code.length).toBeLessThanOrEqual(40);
        expect(decodeDeck(code)).toEqual({ race, cards: sorted(deck) });
      }
    }
  });

  it('do not depend on card order, and keep partial decks', () => {
    const deck = starterDeck('degens');
    expect(encodeDeck('degens', [...deck].reverse())).toBe(encodeDeck('degens', deck));
    expect(decodeDeck(encodeDeck('brokers', [])).cards).toEqual([]);
    const few = starterDeck('brokers').slice(0, 7);
    expect(decodeDeck(encodeDeck('brokers', few)).cards).toEqual(sorted(few));
  });

  it('are found inside pasted text', () => {
    const code = encodeDeck('prophets', starterDeck('prophets'));
    expect(decodeDeck(`my ladder deck 👉 ${code} gl hf`).race).toBe('prophets');
    expect(decodeDeck(`  ${code}\n`).race).toBe('prophets');
    expect(decodeDeck(`OFFICIAL OFFSEASON list: ${code}`).race).toBe('prophets'); // other FF runs are skipped
    // Next to characters a code could contain: Markdown italics, a dash, letters glued on.
    for (const post of [`_${code}_`, `${code}-gl`, `${code}__`, `OFF${code}`, `**${code}**`]) expect(decodeDeck(post).race, post).toBe('prophets');
  });

  it('refuse a mistyped, truncated or foreign code instead of opening the wrong deck', () => {
    // Codes of every length mod 4, so the last character's unused bits are covered too.
    const codes = RACES.flatMap((r) => [encodeDeck(r, starterDeck(r)), encodeDeck(r, withLegendary(r)), encodeDeck(r, starterDeck(r).slice(0, 7))]);
    expect(new Set(codes.map((c) => (c.length - 2) % 4)).size).toBeGreaterThanOrEqual(2);
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (const code of codes) {
      for (let i = 2; i < code.length; i++) {
        for (const ch of B64) {
          if (ch === code[i]) continue;
          expect(() => decodeDeck(code.slice(0, i) + ch + code.slice(i + 1)), `${code} char ${i} → ${ch}`).toThrow(DeckCodeError);
        }
      }
      for (let n = 3; n < code.length; n++) expect(() => decodeDeck(code.slice(0, n)), `length ${n}`).toThrow(DeckCodeError);
    }
    expect(() => decodeDeck('hello')).toThrow(/isn’t a Forkfall deck code/);
    expect(() => decodeDeck('FF!!!!')).toThrow(DeckCodeError);
    const start = Date.now();
    expect(() => decodeDeck('FF-'.repeat(200_000))).toThrow(DeckCodeError); // a pathological paste stays quick
    expect(() => decodeDeck('FFAAAAAA '.repeat(200_000))).toThrow(DeckCodeError);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('refuse more than 2 copies, and decode no card outside the race', () => {
    const one = starterDeck('agents')[0];
    expect(() => encodeDeck('agents', [one, one, one])).toThrow(/at most 2/);
    const prophetCard = COLLECTIBLE.find((c) => c.faction === 'prophets')!;
    expect(() => decodeDeck(encodeDeck('agents', [prophetCard.id]))).toThrow(/puts .* in a agents deck/);
    expect(() => decodeDeck(encodeDeck('agents', [9999]))).toThrow(/doesn’t know/);
  });
});
