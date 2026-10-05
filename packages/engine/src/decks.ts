import {
  COLLECTIBLE, DECK_SIZE, MAX_COPIES, MAX_LEGENDARIES_RANKED, MAX_LEGENDARY_COPIES, RANKED_RARITY_CAP, RARITY_POINTS, setOf,
} from './cards.ts';
import { keccakHex, shuffle } from './rng.ts';
import type { Race } from './types.ts';

/**
 * A random ranked-legal 30-card deck from the race's whole core pool (race cards and core neutrals), the same for
 * the same seed. The balance sim plays these next to the starter decks, so every card in the set gets played, not
 * only the 15 in each starter. Copies are drawn in random order and kept while the deck stays legal (copy limits,
 * at most one Legendary, the ranked rarity budget).
 */
export function randomRankedDeck(race: Race, seed: string): number[] {
  const copies = COLLECTIBLE
    .filter((c) => setOf(c) === 'core' && (c.faction === race || c.faction === 'neutral'))
    .flatMap((c) => Array<number>(c.rarity === 'legendary' ? MAX_LEGENDARY_COPIES : MAX_COPIES).fill(c.id));
  const byId = new Map(COLLECTIBLE.map((c) => [c.id, c]));
  // A small pool can spend the rarity budget before 30 cards: shuffle again (still determined by the seed).
  for (let attempt = 0; attempt < 100; attempt++) {
    const deck: number[] = [];
    let points = 0;
    let legendaries = 0;
    for (const id of shuffle(copies, keccakHex('ranked-deck', race, seed, String(attempt)))) {
      if (deck.length === DECK_SIZE) break;
      const c = byId.get(id)!;
      const legendary = c.rarity === 'legendary';
      if (legendary && legendaries >= MAX_LEGENDARIES_RANKED) continue;
      if (points + RARITY_POINTS[c.rarity] > RANKED_RARITY_CAP) continue;
      deck.push(id);
      points += RARITY_POINTS[c.rarity];
      if (legendary) legendaries++;
    }
    if (deck.length === DECK_SIZE) return deck.sort((a, b) => a - b);
  }
  throw new Error(`the ${race} pool can't fill a ranked-legal deck`);
}
