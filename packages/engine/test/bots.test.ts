import { describe, expect, it } from 'vitest';
import {
  createMatch, greedyBot, keccakHex, legalActions, predictionOdds, starterDeck, TOKEN_TACO,
  type GameState, type PredictionCondition, type Race, type Seat, type UnitState, card,
} from '../src/index.ts';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);

/** A match in progress with empty hands and boards. */
function fresh(r0: Race = 'agents', r1: Race = 'brokers'): GameState {
  const g = createMatch({
    matchId: 'bots', seed: keccakHex('bots'),
    players: [
      { address: A, race: r0, deck: starterDeck(r0), deckSalt: '0x11' },
      { address: B, race: r1, deck: starterDeck(r1), deckSalt: '0x22' },
    ],
  }).state;
  for (const p of g.players) { p.hand = []; p.board = []; p.predictions = []; p.treasury = 25; }
  return g;
}
const hand = (g: GameState, cardId: number) => { const uid = g.nextUid++; g.players[g.active].hand.push({ uid, cardId }); return uid; };
function unit(g: GameState, seat: Seat, cardId: number, over: Partial<UnitState> = {}): number {
  const c = card(cardId);
  const uid = g.nextUid++;
  g.players[seat].board.push({
    uid, cardId, attack: c.attack!, health: c.health!, maxHealth: c.health!, keywords: [...c.keywords],
    summonedTurn: 0, attacksThisTurn: 0, attackedLastOwnTurn: false, rushThisTurn: false, ...over,
  });
  return uid;
}

describe('greedy bot', () => {
  it('plays Flash Loan when the Gas it gives buys a card it couldn’t afford', () => {
    const g = fresh();
    const loan = hand(g, 164); // Flash Loan: 0 Gas, gain 2
    hand(g, 40); // Genesis Block: 5 Gas 5/5 Guard
    g.players[g.active].gas = 3;
    expect(greedyBot()(g, g.active)).toEqual({ type: 'play', uid: loan });
  });

  it('keeps Flash Loan when the Gas would buy nothing', () => {
    const g = fresh();
    hand(g, 164);
    g.players[g.active].gas = 3;
    expect(greedyBot()(g, g.active)).toEqual({ type: 'endTurn' });
  });

  it('is deterministic and only returns legal actions', () => {
    const g = fresh('degens', 'agents');
    for (const id of [25, 26, 28, 30, 31]) hand(g, id);
    unit(g, g.active, 27);
    unit(g, (1 - g.active) as Seat, 1);
    g.players[g.active].gas = 6;
    const a = greedyBot()(g, g.active);
    expect(greedyBot()(g, g.active)).toEqual(a);
    expect(legalActions(g, g.active)).toContainEqual(a);
  });

  it('stays legal with many enablers in hand (each card gets one second look, at most four)', () => {
    const g = fresh();
    for (let i = 0; i < 10; i++) hand(g, TOKEN_TACO);
    for (let i = 0; i < 5; i++) { unit(g, g.active, 34); unit(g, (1 - g.active) as Seat, 34); }
    g.players[g.active].gas = 10;
    expect(legalActions(g, g.active)).toContainEqual(greedyBot()(g, g.active));
  });
});

describe('prediction odds', () => {
  const conds: PredictionCondition[] = ['attacks', 'attacks2', 'playsBigUnit', 'plays3Cards', 'summons3'];

  it('are probabilities for every race, board, Gas and hand size', () => {
    for (const race of ['agents', 'prophets', 'brokers', 'degens'] as Race[]) {
      for (const units of [0, 1, 2, 5]) for (const maxGas of [1, 3, 5, 9]) for (const handSize of [0, 2, 5, 9]) {
        const g = fresh('prophets', race);
        const op = (1 - g.active) as Seat;
        for (let i = 0; i < units; i++) unit(g, op, 34);
        g.players[op].maxGas = maxGas;
        for (let i = 0; i < handSize; i++) g.players[op].hand.push({ uid: g.nextUid++, cardId: 34 });
        for (const c of conds) {
          const p = predictionOdds(g, g.active, c);
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('follow what bots actually do: no attack without units (except Degens’ Rush), 3+ cards rare before 6 Gas', () => {
    const g = fresh('prophets', 'agents');
    const op = (1 - g.active) as Seat;
    expect(predictionOdds(g, g.active, 'attacks')).toBeLessThan(0.1);
    g.players[op].race = 'degens';
    expect(predictionOdds(g, g.active, 'attacks')).toBeGreaterThan(0.2);
    unit(g, op, 34);
    expect(predictionOdds(g, g.active, 'attacks')).toBeGreaterThan(0.8);
    g.players[op].maxGas = 3;
    expect(predictionOdds(g, g.active, 'plays3Cards')).toBeLessThan(0.05);
    g.players[op].maxGas = 7;
    expect(predictionOdds(g, g.active, 'plays3Cards')).toBeGreaterThan(0.1);
  });
});
