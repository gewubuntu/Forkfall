import { describe, expect, it } from 'vitest';
import {
  applyAction, card, COLLECTIBLE, createMatch, greedyBot, keccakHex, legalActions, playOut, randomRankedDeck, RACES, setOf,
  starterDeck, TOKEN_BOND, TOKEN_DRONE, validateDeck,
  type Action, type GameState, type Race, type Rarity, type Seat, type UnitState,
} from '../src/index.ts';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);

/** A match in progress with empty hands and boards, so a test sets up exactly what it needs. */
function fresh(): GameState {
  const g = createMatch({
    matchId: 'set1', seed: keccakHex('set1'),
    players: [
      { address: A, race: 'agents', deck: starterDeck('agents'), deckSalt: '0x11' },
      { address: B, race: 'brokers', deck: starterDeck('brokers'), deckSalt: '0x22' },
    ],
  }).state;
  for (const p of g.players) { p.hand = []; p.board = []; p.predictions = []; p.treasury = 25; }
  return g;
}
function hand(g: GameState, cardId: number, gas = 10): number {
  const uid = g.nextUid++;
  g.players[g.active].hand.push({ uid, cardId });
  g.players[g.active].gas = gas;
  return uid;
}
function unit(g: GameState, seat: Seat, cardId: number, over: Partial<UnitState> = {}): number {
  const c = card(cardId);
  const uid = g.nextUid++;
  g.players[seat].board.push({
    uid, cardId, attack: c.attack!, health: c.health!, maxHealth: c.health!, keywords: [...c.keywords],
    summonedTurn: 0, attacksThisTurn: 0, attackedLastOwnTurn: false, rushThisTurn: false, ...over,
  });
  return uid;
}
const predict = (g: GameState, seat: Seat) =>
  g.players[seat].predictions.push({ uid: g.nextUid++, cardId: 9, condition: 'attacks', resolvesOnTurn: g.turn + 1 });
const opp = (g: GameState) => (1 - g.active) as Seat;
const play = (g: GameState, a: Omit<Extract<Action, { type: 'play' }>, 'type'>) => applyAction(g, g.active, { type: 'play', ...a }).state;
/** End the active player's turn and the opponent's, back to the same player's next turn. */
const fullRound = (g: GameState) => { const r = applyAction(g, g.active, { type: 'endTurn' }).state; return applyAction(r, r.active, { type: 'endTurn' }).state; };

describe('Set 1 card list', () => {
  const core = COLLECTIBLE.filter((c) => setOf(c) === 'core');
  const count = (faction: string) => {
    const out: Record<Rarity, number> = { common: 0, uncommon: 0, rare: 0, legendary: 0 };
    for (const c of core.filter((x) => x.faction === faction)) out[c.rarity]++;
    return out;
  };

  it('has 160 cards: 36 per race (18/11/5/2) and 16 neutral (8/4/4/0), as the GDD sets out', () => {
    expect(core).toHaveLength(160);
    for (const r of RACES) expect(count(r)).toEqual({ common: 18, uncommon: 11, rare: 5, legendary: 2 });
    expect(count('neutral')).toEqual({ common: 8, uncommon: 4, rare: 4, legendary: 0 });
  });

  it('uses ids 1–40 and 49–168 with unique slugs and names', () => {
    expect(core.map((c) => c.id).sort((a, b) => a - b)).toEqual([...Array(40).keys()].map((i) => i + 1).concat([...Array(120).keys()].map((i) => i + 49)));
    expect(new Set(COLLECTIBLE.map((c) => c.slug)).size).toBe(COLLECTIBLE.length);
    expect(new Set(COLLECTIBLE.map((c) => c.name)).size).toBe(COLLECTIBLE.length);
  });

  it('every card is legal to play in some state, and every legal play of it resolves', () => {
    for (const c of COLLECTIBLE) {
      const g = fresh();
      const me = g.active;
      unit(g, me, 34); // a friendly and an enemy target
      unit(g, opp(g), 34);
      const uid = hand(g, c.id);
      const plays = legalActions(g, me).filter((a) => a.type === 'play' && a.uid === uid);
      expect(plays.length, c.name).toBeGreaterThan(0);
      for (const a of plays) expect(() => applyAction(g, me, a), `${c.name} ${JSON.stringify(a)}`).not.toThrow();
    }
  });

  it('pool decks of the full set are legal and play out to the end', () => {
    for (const [i, r] of RACES.entries()) {
      const deck = randomRankedDeck(r, `set1-${i}`);
      expect(validateDeck(r, deck, true).errors).toEqual([]);
      const foe: Race = RACES[(i + 1) % 4];
      const g = createMatch({
        matchId: `pool-${r}`, seed: keccakHex('pool', r),
        players: [
          { address: A, race: r, deck, deckSalt: '0x1' },
          { address: B, race: foe, deck: randomRankedDeck(foe, `set1-foe-${i}`), deckSalt: '0x2' },
        ],
      }).state;
      expect(playOut(g, [greedyBot(), greedyBot()]).status).toBe('ended');
    }
  });
});

describe('Set 1 card effects', () => {
  it('Piggy Bank pays its Gas Dividend on the turn it Holds', () => {
    let g = fresh();
    const me = g.active;
    unit(g, me, 106, { summonedTurn: g.turn - 2 });
    g = fullRound(g);
    expect(g.players[me].gas).toBe(g.players[me].maxGas + 1);
  });

  it('Escrow Agent and Private Equity drop their Bonds when they die', () => {
    const g = fresh();
    const o = opp(g);
    unit(g, o, 109, { health: 1 });
    unit(g, o, 126, { health: 1 });
    const fire = hand(g, 39); // Hard Fork: 2 damage to every unit
    const after = play(g, { uid: fire });
    expect(after.players[o].board.map((u) => u.cardId).sort()).toEqual(Array(4).fill(TOKEN_BOND));
  });

  it('Long Position and Treasury Bill give Hold', () => {
    let g = fresh();
    const me = g.active;
    unit(g, me, 34);
    unit(g, me, 34);
    g = play(g, { uid: hand(g, 118) });
    expect(g.players[me].board.every((u) => u.keywords.includes('hold') && u.attack === 4 && u.health === 4)).toBe(true);
    g = fresh();
    unit(g, g.active, 34);
    const t = g.players[g.active].board[0].uid;
    const deck = g.players[g.active].deck.length;
    g = play(g, { uid: hand(g, 110), target: t });
    expect(g.players[g.active].board[0]).toMatchObject({ attack: 4, health: 4 });
    expect(g.players[g.active].board[0].keywords).toContain('hold');
    expect(deck - g.players[g.active].deck.length).toBe(1);
  });

  it('Bad Omen and Forked Path hit the Treasury only with an active prediction', () => {
    for (const withPrediction of [false, true]) {
      let g = fresh();
      const o = opp(g);
      if (withPrediction) predict(g, g.active);
      const e = unit(g, o, 34);
      g = play(g, { uid: hand(g, 95), target: e });
      g = play(g, { uid: hand(g, 97) });
      expect(g.players[o].board[0].health).toBe(1);
      expect(g.players[o].treasury).toBe(withPrediction ? 21 : 25);
    }
  });

  it('High Priestess stops backfire', () => {
    let g = fresh();
    const me = g.active;
    unit(g, me, 102);
    g.players[me].predictions.push({ uid: g.nextUid++, cardId: 103, condition: 'attacks', resolvesOnTurn: g.turn + 1 });
    g = fullRound(g); // the opponent didn't attack: Grand Augury misses
    expect(g.players[me].treasury).toBe(25);
  });

  it('The Last Prophet buffs the board on each correct prediction', () => {
    let g = fresh();
    const me = g.active;
    unit(g, me, 104);
    unit(g, me, 34);
    predict(g, me);
    g = applyAction(g, me, { type: 'endTurn' }).state;
    g.players[g.active].stats.attackers.push(1); // the opponent attacked: the prediction comes true
    g = applyAction(g, g.active, { type: 'endTurn' }).state;
    expect(g.players[me].board.map((u) => [u.attack, u.health])).toEqual([[8, 11], [5, 5]]);
  });

  it('Smart Contract and The Swarm Mind act at the start of your turn', () => {
    let g = fresh();
    const me = g.active;
    unit(g, me, 34);
    g = play(g, { uid: hand(g, 81) });
    g = fullRound(g);
    expect(g.players[me].board.map((u) => [u.cardId, u.attack, u.health])).toEqual([[34, 4, 4], [TOKEN_DRONE, 1, 1]]);
    g = fresh();
    unit(g, me, 85);
    g = fullRound(g);
    expect(g.players[me].board.map((u) => [u.cardId, u.attack])).toEqual([[85, 6], [TOKEN_DRONE, 2]]);
  });

  it('Soft Rug and Pump and Dump sacrifice the unit for its attack (+1 for Pump and Dump, after the Pump)', () => {
    let g = fresh();
    const me = g.active;
    const o = opp(g);
    const u = unit(g, me, 34);
    g = play(g, { uid: hand(g, 133), target: u });
    expect(g.players[me].board).toHaveLength(0);
    expect(g.players[o].treasury).toBe(22);
    // Pump and Dump: the Treasury takes the attack the unit had after its Pump, plus 1.
    const attacks = new Set<number>();
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const h = fresh();
      h.seed = keccakHex('pump-and-dump', seed);
      const v = unit(h, h.active, 34);
      const r = applyAction(h, h.active, { type: 'play', uid: hand(h, 150), target: v });
      const pumped = r.events.find((e) => e.t === 'stat' && e.uid === v) as { attack: number } | undefined;
      expect(pumped).toBeDefined();
      expect(r.state.players[me].board).toHaveLength(0);
      expect(25 - r.state.players[o].treasury).toBe(pumped!.attack + 1);
      attacks.add(pumped!.attack);
    }
    expect(Math.max(...attacks)).toBeGreaterThan(3); // some seeds pump attack, so a Rug reading the old attack would fail
  });

  it('Activist Investor only targets enemy units, and is a plain 5/4 Rush when there are none', () => {
    const g = fresh();
    const me = g.active;
    const mine = unit(g, me, 34);
    const uid = hand(g, 129);
    expect(legalActions(g, me).filter((a) => a.type === 'play' && a.uid === uid)).toEqual([{ type: 'play', uid }]);
    expect(() => play(g, { uid, target: mine })).toThrow();
    const after = play(g, { uid });
    expect(after.players[me].board.find((x) => x.uid === mine)!.health).toBe(3);
    const e = unit(g, opp(g), 34);
    expect(play(g, { uid, target: e }).players[opp(g)].board[0].health).toBe(1);
  });

  it('Leverage x100 doubles every friendly unit; Telegram Pump gives them all Rush', () => {
    let g = fresh();
    const me = g.active;
    unit(g, me, 34, { summonedTurn: g.turn });
    unit(g, me, 135, { summonedTurn: g.turn });
    g = play(g, { uid: hand(g, 156) });
    expect(g.players[me].board.map((u) => u.attack)).toEqual([6, 4]);
    g = fresh();
    unit(g, me, 34, { summonedTurn: g.turn });
    g = play(g, { uid: hand(g, 153) });
    expect(legalActions(g, me).some((a) => a.type === 'attack')).toBe(true);
  });

  it('The Meme King pumps everyone, then buffs Swarm units', () => {
    let g = fresh();
    const me = g.active;
    unit(g, me, 34);
    unit(g, me, 135);
    g = play(g, { uid: hand(g, 160) });
    const [validator, gremlin, king] = g.players[me].board;
    const growth = (u: UnitState, base: number[]) => u.attack + u.health - base[0] - base[1];
    expect(growth(validator, [3, 3])).toBeGreaterThanOrEqual(1);
    expect(growth(validator, [3, 3])).toBeLessThanOrEqual(3);
    expect(growth(gremlin, [2, 1])).toBeGreaterThanOrEqual(3); // pump 1–3, +2 from the Swarm buff
    expect(growth(king, [5, 5])).toBeGreaterThanOrEqual(3);
  });

  it('Dark Pool and Jeet hit the enemy Treasury when they die', () => {
    let g = fresh();
    const o = opp(g);
    unit(g, o, 167, { health: 2 });
    unit(g, o, 147);
    g = play(g, { uid: hand(g, 39) });
    expect(g.players[o].board).toHaveLength(0);
    expect(g.players[g.active].treasury).toBe(25 - 3); // Dark Pool 2, Jeet 1
  });

  it('Flash Loan gives 2 Gas this turn', () => {
    let g = fresh();
    g = play(g, { uid: hand(g, 164, 3) });
    expect(g.players[g.active].gas).toBe(5);
  });
});
