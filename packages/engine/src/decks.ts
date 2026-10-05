import {
  COLLECTIBLE, DECK_SIZE, MAX_COPIES, MAX_LEGENDARIES_RANKED, MAX_LEGENDARY_COPIES, RANKED_RARITY_CAP, RARITY_POINTS, setOf,
} from './cards.ts';
import { keccakHex, shuffle } from './rng.ts';
import type { Race } from './types.ts';

/**
 * A random ranked-legal 30-card deck from the race's whole core pool (race cards and core neutrals), the same for
 * the same seed. The balance sim plays these next to the starter decks, so every card in the set gets played, not
 * only the 15 in each starter. Like a ranked player's deck it always runs a Legendary of the race (one of them, at
 * random, once there are two); the rest are copies drawn in random order and kept while the deck stays legal (copy
 * limits, the ranked rarity budget).
 */
export function randomRankedDeck(race: Race, seed: string): number[] {
  const copies = COLLECTIBLE
    .filter((c) => setOf(c) === 'core' && (c.faction === race || c.faction === 'neutral'))
    .flatMap((c) => Array<number>(c.rarity === 'legendary' ? MAX_LEGENDARY_COPIES : MAX_COPIES).fill(c.id));
  const byId = new Map(COLLECTIBLE.map((c) => [c.id, c]));
  const legends = [...new Set(copies.filter((id) => byId.get(id)!.rarity === 'legendary' && byId.get(id)!.faction === race))];
  // A small pool can spend the rarity budget before 30 cards: shuffle again (still determined by the seed).
  for (let attempt = 0; attempt < 100; attempt++) {
    const order = shuffle(copies, keccakHex('ranked-deck', race, `${seed}:${attempt}`));
    const legend = legends.length ? shuffle(legends, keccakHex('ranked-legend', race, `${seed}:${attempt}`))[0] : undefined;
    const deck: number[] = legend === undefined ? [] : [legend];
    let points = legend === undefined ? 0 : RARITY_POINTS.legendary;
    let legendaries = deck.length;
    for (const id of order) {
      if (deck.length === DECK_SIZE) break;
      if (id === legend) continue; // already in
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
