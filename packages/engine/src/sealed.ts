import { card, DECK_SIZE, MAX_COPIES, MAX_LEGENDARY_COPIES } from './cards.ts';
import { keccakHex } from './rng.ts';
import { cardsFor, RULES_VERSION } from './rules.ts';
import type { CardDef, Race } from './types.ts';

/**
 * Sealed (a casual fun mode): open 6 Set 1 boosters, build a 30-card deck from them and the free basic cards (any
 * races), play until 7 wins or 3 losses. The pool is rolled here from a commit-reveal seed, with the same odds and
 * duplicate protection as `PackSale`, so the referee and the browser derive the same pool and anyone can check it.
 */
export const SEALED_PACKS = 6;
export const SEALED_WINS = 7;
export const SEALED_LOSSES = 3;
/** The 8 core neutral starter cards: every Sealed deck may add up to 2 of each, on top of its pool. */
export const SEALED_BASICS: readonly number[] = [33, 34, 35, 36, 37, 38, 39, 40];
export const SEALED_BASIC_COPIES = 2;
/** A Sealed player alone in the queue for this long is matched against a house bot. */
export const SEALED_BOT_AFTER_MS = 45_000;
/** The Sealed queue pairs the same record first, and one step further away for every 10 s waited. */
export const SEALED_WIDEN_MS = 10_000;
/** A run left open this long ends with its record. */
export const SEALED_RUN_DAYS = 7;

export interface SealedCard { id: number; foil: boolean }

/** The pool seed: the server's committed seed, the player's share and the run id (neither side picks the pool alone). */
export const sealedPoolSeed = (serverSeed: string, share: string, runId: string) =>
  keccakHex('forkfall-sealed', serverSeed, share, runId);

const h = (...parts: (string | number)[]) => BigInt(keccakHex(...parts.map(String)));
const FOIL_BPS = 667n; // about 1 card in 15, as PackSale
const LEGENDARY_UPGRADE_BPS = 1000n; // the rare slot becomes a Legendary 1 time in 10, as PackSale

/** The 6 packs of a pool: each 3 Commons, an Uncommon and a Rare (or Legendary), under the given rules version. */
export function sealedPacks(seed: string, rules = RULES_VERSION): SealedCard[][] {
  const table = cardsFor(rules);
  const pools = (['common', 'uncommon', 'rare', 'legendary'] as const).map((r) =>
    [...table.values()].filter((c) => c.collectible && c.rarity === r).map((c) => c.id).sort((a, b) => a - b));
  const pool = new Map<number, number>();
  const packs: SealedCard[][] = [];
  for (let n = 0; n < SEALED_PACKS; n++) {
    const got: number[] = [];
    // Start at a random card; walk to the first one held fewer than `limit` times (this pack and the pool so far).
    const pick = (ids: number[], r: bigint, limit: number) => {
      const start = Number(r % BigInt(ids.length));
      for (let k = 0; k < ids.length; k++) {
        const id = ids[(start + k) % ids.length];
        if ((pool.get(id) ?? 0) + got.filter((g) => g === id).length < limit) return id;
      }
      return ids[start];
    };
    for (let i = 0; i < 3; i++) got.push(pick(pools[0], h(seed, n, i), MAX_COPIES));
    got.push(pick(pools[1], h(seed, n, 3), MAX_COPIES));
    const legendary = h(seed, n, 'legendary') % 10_000n < LEGENDARY_UPGRADE_BPS && pools[3].length > 0;
    got.push(pick(legendary ? pools[3] : pools[2], h(seed, n, 4), legendary ? MAX_LEGENDARY_COPIES : MAX_COPIES));
    for (const id of got) pool.set(id, (pool.get(id) ?? 0) + 1);
    packs.push(got.map((id, i) => ({ id, foil: h(seed, n, 'foil', i) % 10_000n < FOIL_BPS })));
  }
  return packs;
}

/** Copies of each card the packs hold (foils count as the card). */
export function sealedPool(packs: SealedCard[][]): Map<number, number> {
  const pool = new Map<number, number>();
  for (const p of packs) for (const c of p) pool.set(c.id, (pool.get(c.id) ?? 0) + 1);
  return pool;
}

const maxCopies = (id: number) => (card(id).rarity === 'legendary' ? MAX_LEGENDARY_COPIES : MAX_COPIES);

/** How many copies of a card a Sealed deck may hold: the pool's copies plus the free basics, within the copy limits. */
export function sealedAllowed(pool: ReadonlyMap<number, number>, id: number): number {
  return Math.min(maxCopies(id), (pool.get(id) ?? 0) + (SEALED_BASICS.includes(id) ? SEALED_BASIC_COPIES : 0));
}

export interface SealedDeckCheck { ok: boolean; errors: string[] }

/** A Sealed deck: 30 collectible cards, any races, copy limits, and only cards the pool (and the basics) allow. */
export function validateSealedDeck(deck: number[], pool?: ReadonlyMap<number, number>): SealedDeckCheck {
  const errors: string[] = [];
  if (deck.length !== DECK_SIZE) errors.push(`deck must have ${DECK_SIZE} cards, has ${deck.length}`);
  const counts = new Map<number, number>();
  for (const id of deck) {
    const c = Number.isInteger(id) ? safeCard(id) : undefined;
    if (!c || !c.collectible) { errors.push(`card ${id} is not collectible`); continue; }
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [id, n] of counts) {
    const c = card(id);
    if (n > maxCopies(id)) errors.push(`${c.name}: ${n} copies (max ${maxCopies(id)})`);
    else if (pool && n > sealedAllowed(pool, id)) errors.push(`${c.name}: ${n} copies, your pool has ${sealedAllowed(pool, id)}`);
  }
  return { ok: errors.length === 0, errors };
}

function safeCard(id: number): CardDef | undefined { try { return card(id); } catch { return undefined; } }

/** The race a mixed deck counts as (most cards; ties by race order), for the match screen and race quests. */
export function sealedRace(deck: number[]): Race {
  const order: Race[] = ['agents', 'prophets', 'brokers', 'degens'];
  const n = new Map<Race, number>();
  for (const id of deck) { const f = safeCard(id)?.faction; if (f && f !== 'neutral') n.set(f, (n.get(f) ?? 0) + 1); }
  return order.reduce((best, r) => ((n.get(r) ?? 0) > (n.get(best) ?? 0) ? r : best), order[0]);
}

const RARITY_VALUE = { common: 1, uncommon: 2, rare: 3, legendary: 4 } as const;

/** One-click deck: the pool's best cards by rarity and stats for their cost, basics filling any gap. */
export function autoBuildSealed(pool: ReadonlyMap<number, number>): number[] {
  const value = (c: CardDef) => RARITY_VALUE[c.rarity] + (((c.attack ?? 0) + (c.health ?? 0)) / Math.max(1, c.cost)) * 0.5 - (c.cost >= 7 ? 1 : 0);
  const copies: number[] = [];
  for (const id of pool.keys()) for (let i = 0; i < sealedAllowed(pool, id); i++) copies.push(id);
  copies.sort((a, b) => value(card(b)) - value(card(a)) || a - b);
  const deck = copies.slice(0, DECK_SIZE);
  for (const b of SEALED_BASICS) while (deck.length < DECK_SIZE && deck.filter((x) => x === b).length < SEALED_BASIC_COPIES) deck.push(b);
  return deck.sort((a, b) => a - b);
}

/** What a free run pays (a gentler table than a paid run's: packs for 4+ wins, Scrap below). One claim per run. */
export interface SealedPrize { scrap: number; packs: number; titleStep: boolean }
export const SEALED_FREE_PRIZES: readonly SealedPrize[] = [
  { scrap: 50, packs: 0, titleStep: false }, // 0 wins
  { scrap: 50, packs: 0, titleStep: false },
  { scrap: 100, packs: 0, titleStep: false },
  { scrap: 100, packs: 0, titleStep: false },
  { scrap: 0, packs: 1, titleStep: false },
  { scrap: 50, packs: 1, titleStep: false },
  { scrap: 100, packs: 1, titleStep: false },
  { scrap: 0, packs: 2, titleStep: true }, // 7 wins
];
export const sealedPrize = (wins: number): SealedPrize => SEALED_FREE_PRIZES[Math.max(0, Math.min(SEALED_WINS, wins))];

/** Sealed titles, unlocked by the referee. */
export const SEALED_TITLES = {
  rookie: { id: 'title:sealed-rookie', name: 'Sealed Rookie', description: 'Finish a Sealed run.' },
  veteran: { id: 'title:sealed-veteran', name: 'Sealed Veteran', description: 'Win 5 or more matches in three Sealed runs.' },
  unsealed: { id: 'title:unsealed', name: 'Unsealed', description: 'Win a Sealed run with 7 wins.' },
} as const;
