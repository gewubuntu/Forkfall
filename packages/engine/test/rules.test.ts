import { describe, expect, it } from 'vitest';
import {
  applyAction, card, CARDS, cardIn, cardPatches, cardsFor, createMatch, currentRulesPinned, keccakHex, legalActions,
  RULES_SINCE, RULES_VERSION, rulesCandidates, rulesFingerprint, starterDeck, type CardDef, type GameState, type Seat,
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

  it('rebuild every older card table exactly as it was played', () => {
    // Fingerprints of packages/engine/src/cards.ts at the merges of #31 (v1), #32 (v2) and #33 (v3), taken from git.
    const pinned: Record<number, string> = {
      1: '0x87fe2708ecd0ecbe1f36071ba1e6b142506265e9de60425a2175c15ecf412e92',
      2: '0x0218a5c6719cddb8f7fdcae8c0d908ba987db308ad4db603d5a911e9dd7de95d',
      3: '0x5d26c17153c09a9127b0e46b7a27111ec099721b30b25e837fa0ee6b44cefdaa',
    };
    for (const v of [1, 2, 3]) expect(rulesFingerprint([...cardsFor(v).values()]), `v${v}`).toBe(pinned[v]);
    expect(cardsFor(RULES_VERSION).get(34)).toBe(card(34)); // the current version is the live table
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

  it('try the version live when an unrecorded match was created first, then older ones, then newer', () => {
    const newer = (v: number) => Array.from({ length: RULES_VERSION - v }, (_, i) => v + 1 + i);
    expect(rulesCandidates()).toEqual([...newer(0)].reverse());
    expect(rulesCandidates(RULES_SINCE[3] + 1000)).toEqual([3, 2, 1, ...newer(3)]);
    expect(rulesCandidates(RULES_SINCE[2] + 1000)).toEqual([2, 1, ...newer(2)]);
    expect(rulesCandidates(RULES_SINCE[2] - 1000)).toEqual([1, ...newer(1)]);
    expect(rulesCandidates(RULES_SINCE[RULES_VERSION] + 1000)[0]).toBe(RULES_VERSION);
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
