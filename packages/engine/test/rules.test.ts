import { describe, expect, it } from 'vitest';
import {
  applyAction, card, CARDS, cardIn, cardPatches, cardsFor, createMatch, currentRulesPinned, keccakHex, legalActions,
  bumpPlan, LAST_UNRECORDED_RULES, RULES_VERSION, rulesCandidates, UNRECORDED_RULES_SINCE, rulesFingerprint, starterDeck, type CardDef, type GameState, type Seat,
} from '../src/index.ts';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);

function match(rules?: number): GameState {
  const g = createMatch({
    matchId: 'rules', seed: keccakHex('rules'), rules,
    players: [
      { address: A, race: 'agents', deck: starterDeck('agents'), deckSalt: '0x11' },
      { address: B, race: 'prophets', deck: starterDeck('prophets'), deckSalt: '0x22' },
    ],
  }).state;
  for (const p of g.players) { p.hand = []; p.board = []; p.predictions = []; }
  return g;
}

describe('rules versions', () => {
  it('pin the live card table: changing how a card plays needs `pnpm rules:bump`', () => {
    expect(currentRulesPinned(), 'card rules changed without a new rules version: run `pnpm rules:bump`').toBe(true);
  });

  // Every version's fingerprint, pinned once it exists: a version that shipped must never be redefined (a
  // `pnpm rules:bump` against a stale base would). v1–v3: cards.ts at the merges of #31, #32 and #33, from git.
  const SHIPPED: Record<number, string> = {
    1: '0x87fe2708ecd0ecbe1f36071ba1e6b142506265e9de60425a2175c15ecf412e92',
    2: '0x0218a5c6719cddb8f7fdcae8c0d908ba987db308ad4db603d5a911e9dd7de95d',
    3: '0x5d26c17153c09a9127b0e46b7a27111ec099721b30b25e837fa0ee6b44cefdaa',
    4: '0xd726527a8290c4cf30884696c284ca2db920a54a0d4b72514d82563fee2c976f',
  };

  it('rebuild every version’s card table exactly as it was pinned, and never redefine one', () => {
    for (let v = 1; v <= RULES_VERSION; v++) {
      const fp = rulesFingerprint([...cardsFor(v).values()]);
      expect(SHIPPED[v], `pin v${v} in SHIPPED: '${fp}'`).toBeDefined();
      expect(fp, `v${v} differs from its pinned fingerprint: was the base stale when you ran rules:bump?`).toBe(SHIPPED[v]);
    }
    expect(cardsFor(RULES_VERSION).get(34)).toBe(card(34)); // the current version is the live table
  });

  it('keep what decides deck legality (collectible, faction, rarity) the same in every version', () => {
    // validateDeck reads these from the live table, so changing one would stop old matches replaying.
    const legality = (v: number) => [...cardsFor(v).values()].map((c) => [c.id, c.collectible, c.faction, c.rarity]);
    for (let v = 1; v < RULES_VERSION; v++) expect(legality(v), `v${v}`).toEqual(legality(RULES_VERSION));
  });

  it('look cards up by version', () => {
    expect(cardIn(3, 34)).toMatchObject({ attack: 3, health: 3 }); // Validator before the dominance fixes
    expect(cardIn(4, 34)).toMatchObject({ attack: card(34).attack, health: card(34).health });
    expect(cardIn(1, 32).keywords).toEqual(['rush', 'ape']); // Sticker Dragon lost Rush in v2
    expect('targetIfPrediction' in cardIn(3, 53)).toBe(false); // Augur's flag is new in v4
    expect(cardIn(3, 53).name).toBe('Augur');
    expect(() => cardIn(0, 34)).toThrow(/rules version/);
    expect(() => cardIn(RULES_VERSION + 1, 34)).toThrow(/rules version/);
  });

  it('play a match by the rules it was created under', () => {
    for (const [rules, stats] of [[3, [3, 3]], [undefined, [card(34).attack, card(34).health]]] as const) {
      const g = match(rules);
      expect(g.rules).toBe(rules ?? RULES_VERSION);
      const seat = g.active as Seat;
      g.players[seat].gas = 10;
      g.players[seat].hand.push({ uid: g.nextUid++, cardId: 34 });
      const uid = g.players[seat].hand[0].uid;
      const s = applyAction(g, seat, { type: 'play', uid }).state;
      expect([s.players[seat].board[0].attack, s.players[seat].board[0].health]).toEqual(stats);
    }
  });

  it('keep each version’s targeting: Augur needs a target in v3, not in v4 without a prediction', () => {
    for (const rules of [3, 4]) {
      const g = match(rules);
      const seat = g.active as Seat;
      g.players[seat].gas = 10;
      const uid = g.nextUid++;
      g.players[seat].hand.push({ uid, cardId: 53 });
      g.players[1 - seat].board.push({
        uid: g.nextUid++, cardId: 34, attack: 3, health: 3, maxHealth: 3, keywords: [],
        summonedTurn: 0, attacksThisTurn: 0, attackedLastOwnTurn: false, rushThisTurn: false,
      });
      const untargeted = legalActions(g, seat).some((a) => a.type === 'play' && a.uid === uid && a.target === undefined);
      expect(untargeted, `v${rules}`).toBe(rules === 4);
    }
  });

  it('refuse a version that doesn’t exist', () => {
    expect(() => match(0)).toThrow(/unknown rules version/);
    expect(() => match(RULES_VERSION + 1)).toThrow(/unknown rules version/);
    expect(() => match(1.5)).toThrow(/unknown rules version/);
  });

  it('try unrecorded matches under the version live when created, then older, then newer of that era, then later ones', () => {
    const later = Array.from({ length: RULES_VERSION - LAST_UNRECORDED_RULES }, (_, i) => LAST_UNRECORDED_RULES + 1 + i);
    expect(rulesCandidates()).toEqual([3, 2, 1, ...later]);
    expect(rulesCandidates(Date.now())).toEqual([3, 2, 1, ...later]); // after v3: v4 shipped with recording
    expect(rulesCandidates(UNRECORDED_RULES_SINCE[3] + 1000)).toEqual([3, 2, 1, ...later]);
    expect(rulesCandidates(UNRECORDED_RULES_SINCE[2] + 1000)).toEqual([2, 1, 3, ...later]);
    expect(rulesCandidates(UNRECORDED_RULES_SINCE[2] - 1000)).toEqual([1, 2, 3, ...later]);
  });

  it('plan a bump: one version past the base, redone on re-runs, dropped on revert, refused against a stale base', () => {
    const v3 = { version: 3, fingerprint: '0x3' }, v4 = { version: 4, fingerprint: '0x4' };
    expect(bumpPlan(v3, v3, '0x3')).toEqual({ action: 'unchanged' });
    expect(bumpPlan(v3, v3, '0xnew')).toEqual({ action: 'bump', version: 4, patchOf: 3 });
    expect(bumpPlan(v3, v4, '0xnewer')).toEqual({ action: 'bump', version: 4, patchOf: 3 }); // re-run on this branch
    expect(bumpPlan(v3, v4, '0x4')).toEqual({ action: 'unchanged' });
    expect(bumpPlan(v3, v4, '0x3')).toEqual({ action: 'revert' }); // cards back to the base's
    expect(bumpPlan(v3, { version: 5, fingerprint: '0x5' }, '0xnew').action).toBe('refuse'); // base two behind
    expect(bumpPlan(v4, v3, '0xnew').action).toBe('refuse'); // base ahead: merge it first
  });

  it('describe a change as patches on the newer table (null: absent before), and never allow removing a card', () => {
    const v = card(34);
    const newer: CardDef[] = [{ ...v, attack: 9, targetOptional: true }, { ...v, id: 9999 }];
    expect(cardPatches([v], newer)).toEqual({ 34: { attack: v.attack, targetOptional: null }, 9999: null });
    expect(() => cardPatches([v, { ...v, id: 9999 }], [v])).toThrow(/removed/);
    // Display fields don't change the fingerprint; anything that plays does.
    expect(rulesFingerprint([{ ...v, text: 'x', name: 'y' }])).toBe(rulesFingerprint([v]));
    expect(rulesFingerprint([{ ...v, cost: v.cost + 1 }])).not.toBe(rulesFingerprint([v]));
    expect(rulesFingerprint(CARDS)).toBe(rulesFingerprint([...CARDS].reverse()));
  });
});
