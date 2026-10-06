import { describe, expect, it } from 'vitest';
import {
  applyAction, autoBuildSealed, card, cosmetic, createMatch, DECK_SIZE, greedyBot, IllegalAction, keccakHex, milestoneMet, playOut,
  SEALED_BASICS, SEALED_FREE_PRIZES, SEALED_PACKS, SEALED_WINS, sealedAllowed, sealedPacks, sealedPool, sealedPoolSeed, sealedPrize,
  sealedRace, validateDeck, validateSealedDeck,
} from '../src/index.ts';

const seed = (i: number) => sealedPoolSeed(keccakHex('server', String(i)), keccakHex('share', String(i)), `run-${i}`);

describe('Sealed pools', () => {
  it('rolls 6 packs of 5 the same way every time, from the seed alone', () => {
    const a = sealedPacks(seed(1));
    expect(a).toHaveLength(SEALED_PACKS);
    for (const p of a) expect(p).toHaveLength(5);
    expect(sealedPacks(seed(1))).toEqual(a);
    expect(sealedPacks(seed(2))).not.toEqual(a);
  });

  it('follows the pack odds: 3 Commons, 1 Uncommon, then a Rare or Legendary, with duplicate protection', () => {
    let legendaries = 0, foils = 0, cards = 0;
    for (let i = 0; i < 300; i++) {
      const packs = sealedPacks(seed(i));
      for (const p of packs) {
        expect(p.slice(0, 3).every((c) => card(c.id).rarity === 'common')).toBe(true);
        expect(card(p[3].id).rarity).toBe('uncommon');
        expect(['rare', 'legendary']).toContain(card(p[4].id).rarity);
        legendaries += card(p[4].id).rarity === 'legendary' ? 1 : 0;
        for (const c of p) { foils += c.foil ? 1 : 0; cards++; }
      }
      for (const [id, n] of sealedPool(packs)) expect(n).toBeLessThanOrEqual(card(id).rarity === 'legendary' ? 1 : 2);
    }
    expect(legendaries / (300 * SEALED_PACKS)).toBeGreaterThan(0.05);
    expect(legendaries / (300 * SEALED_PACKS)).toBeLessThan(0.16);
    expect(foils / cards).toBeGreaterThan(0.04);
    expect(foils / cards).toBeLessThan(0.1);
  });

  it('always makes a deck: at least 30 legal copies in the pool, basics only as a choice', () => {
    for (let i = 0; i < 200; i++) {
      const pool = sealedPool(sealedPacks(seed(i)));
      const deck = autoBuildSealed(pool);
      expect(deck).toHaveLength(DECK_SIZE);
      expect(validateSealedDeck(deck, pool)).toEqual({ ok: true, errors: [] });
      let usable = 0;
      for (const id of pool.keys()) usable += sealedAllowed(pool, id);
      expect(usable).toBeGreaterThanOrEqual(DECK_SIZE);
    }
  });
});

describe('Sealed decks', () => {
  const pool = sealedPool(sealedPacks(seed(7)));

  it('lifts the one-race rule but keeps copy limits and the pool', () => {
    const mixed = autoBuildSealed(pool);
    expect(new Set(mixed.map((id) => card(id).faction).filter((f) => f !== 'neutral')).size).toBeGreaterThan(1);
    expect(validateDeck(sealedRace(mixed), mixed).ok).toBe(false); // not a constructed deck
    expect(validateSealedDeck(mixed).ok).toBe(true);
    expect(validateSealedDeck(mixed.slice(1)).errors.join()).toMatch(/30 cards/);
    expect(validateSealedDeck(Array(30).fill(mixed[0])).errors.join()).toMatch(/copies \(max/); // copy limits
    // A card outside the pool (and not a basic) is refused by the pool check, though a free-standing deck may hold it.
    const out = card(1).faction !== 'neutral' && !pool.has(1) ? 1 : [...Array(40).keys()].map((i) => i + 1).find((id) => !pool.has(id) && !SEALED_BASICS.includes(id))!;
    const swapped = [...mixed.filter((id) => id !== mixed[0]).slice(0, 28), mixed[0], out];
    expect(validateSealedDeck(swapped).ok).toBe(true);
    expect(validateSealedDeck(swapped, pool).errors.join()).toMatch(/your pool has 0/);
    expect(validateSealedDeck([...Array(30)].map(() => 1), pool).ok).toBe(false); // not in the pool, over the limit
    expect(validateSealedDeck([...mixed.slice(0, 29), 9999]).errors.join()).toMatch(/not collectible/);
    expect(validateSealedDeck([...mixed.slice(0, 29), 1.5]).errors.join()).toMatch(/not collectible/);
  });

  it('lets a deck take the free basics beyond its pool, never past two copies', () => {
    const b = SEALED_BASICS[0];
    const empty = new Map<number, number>();
    expect(sealedAllowed(empty, b)).toBe(2);
    expect(sealedAllowed(new Map([[b, 5]]), b)).toBe(2);
    expect(sealedAllowed(empty, 1)).toBe(0);
  });

  it('counts as its most-played race', () => {
    expect(sealedRace([...Array(20)].map(() => 25))).toBe('degens'); // a Degens card
    expect(sealedRace(SEALED_BASICS.slice())).toBe('agents'); // no race: the first
  });

  it('plays as a real match: createMatch accepts a mixed deck only as sealed, and the match runs to the end', () => {
    const [d0, d1] = [autoBuildSealed(sealedPool(sealedPacks(seed(3)))), autoBuildSealed(sealedPool(sealedPacks(seed(4))))];
    const players = (): [{ address: string; race: ReturnType<typeof sealedRace>; deck: number[]; deckSalt: string }, { address: string; race: ReturnType<typeof sealedRace>; deck: number[]; deckSalt: string }] => [
      { address: '0x' + '1'.repeat(40), race: sealedRace(d0), deck: d0, deckSalt: '0x01' },
      { address: '0x' + '2'.repeat(40), race: sealedRace(d1), deck: d1, deckSalt: '0x02' },
    ];
    expect(() => createMatch({ matchId: 'm', seed: keccakHex('m'), players: players() })).toThrow(IllegalAction);
    const { state } = createMatch({ matchId: 'm', seed: keccakHex('m'), players: players(), format: 'sealed' });
    expect(state.players[0].deck.length + state.players[0].hand.length).toBe(DECK_SIZE);
    const end = playOut(state, [greedyBot(), greedyBot()]);
    expect(end.status).toBe('ended');
    expect(() => applyAction(end, 0, { type: 'endTurn' })).toThrow();
  });
});

describe('Sealed prizes', () => {
  it('is the free-run table: Scrap below 4 wins, packs from 4, two packs and a title step at 7', () => {
    expect(SEALED_FREE_PRIZES).toHaveLength(SEALED_WINS + 1);
    expect(sealedPrize(0)).toEqual({ scrap: 50, packs: 0, titleStep: false });
    expect(sealedPrize(3)).toEqual({ scrap: 100, packs: 0, titleStep: false });
    expect(sealedPrize(4)).toEqual({ scrap: 0, packs: 1, titleStep: false });
    expect(sealedPrize(6)).toEqual({ scrap: 100, packs: 1, titleStep: false });
    expect(sealedPrize(7)).toEqual({ scrap: 0, packs: 2, titleStep: true });
    for (const p of SEALED_FREE_PRIZES) { expect(p.scrap).toBeLessThanOrEqual(500); expect(p.packs).toBeLessThanOrEqual(2); } // QuestRewards per-claim caps
  });

  it('pays about what the GDD says at a 50% and 70% win rate', () => {
    for (const [p, packs] of [[0.5, 0.43], [0.7, 1.21]] as const) {
      const mem = new Map<string, number[]>();
      const f = (w: number, l: number): number[] => {
        if (w === SEALED_WINS || l === 3) return [sealedPrize(w).packs, sealedPrize(w).scrap];
        const k = `${w},${l}`; const hit = mem.get(k); if (hit) return hit;
        const a = f(w + 1, l), b = f(w, l + 1);
        const r = [p * a[0] + (1 - p) * b[0], p * a[1] + (1 - p) * b[1]]; mem.set(k, r); return r;
      };
      expect(f(0, 0)[0]).toBeCloseTo(packs, 1);
    }
  });

  it('has three Sealed titles that no collection milestone can unlock', () => {
    for (const id of ['title:sealed-rookie', 'title:sealed-veteran', 'title:unsealed']) {
      const c = cosmetic(id)!;
      expect(c).toMatchObject({ kind: 'title', rule: 'sealed' });
      expect(milestoneMet(c.rule, c.set, () => 99, ['basics'])).toBe(false);
    }
  });
});
