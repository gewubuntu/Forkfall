import { describe, expect, it } from 'vitest';
import {
  applyAction, card, createMatch, eventsFor, IllegalAction, keccakHex, legalActions, playOut,
  randomBot, RACES, RANKED_RARITY_CAP, COLLECTIBLE, starterDeck, validateDeck, viewFor, greedyBot, setOf, TOKEN_TACO, HAND_LIMIT,
  type GameState, type Race, type Seat, type UnitState,
} from '../src/index.ts';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);

function newMatch(r0: Race = 'agents', r1: Race = 'degens', seed = keccakHex('test')): GameState {
  return createMatch({
    matchId: 'm1', seed,
    players: [
      { address: A, race: r0, deck: starterDeck(r0), deckSalt: '0x11' },
      { address: B, race: r1, deck: starterDeck(r1), deckSalt: '0x22' },
    ],
  }).state;
}

/** Put a specific card in the active player's hand and give them gas. */
function withHand(g: GameState, cardId: number, gas = 10): { g: GameState; uid: number } {
  const s = structuredClone(g);
  const uid = s.nextUid++;
  const p = s.players[s.active];
  p.hand.push({ uid, cardId });
  p.gas = gas;
  return { g: s, uid };
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

describe('decks', () => {
  it('starter decks are legal and fit the ranked rarity cap', () => {
    for (const r of RACES) {
      const chk = validateDeck(r, starterDeck(r), true);
      expect(chk.errors).toEqual([]);
      expect(chk.rarityPoints).toBeLessThanOrEqual(RANKED_RARITY_CAP);
    }
  });
  it('ranked fits one Legendary in place of a Rare from the starter list', () => {
    for (const r of RACES) {
      const deck = starterDeck(r);
      const legend = COLLECTIBLE.find((c) => c.faction === r && c.rarity === 'legendary')!;
      deck[deck.findIndex((id) => card(id).rarity === 'rare')] = legend.id;
      const chk = validateDeck(r, deck, true);
      expect(chk.errors).toEqual([]);
      expect(chk.rarityPoints).toBe(RANKED_RARITY_CAP);
    }
  });
  it('rejects off-race cards and too many copies', () => {
    const deck = starterDeck('agents');
    deck[0] = 17; // Intern (brokers)
    expect(validateDeck('agents', deck).ok).toBe(false);
    const deck2 = starterDeck('agents');
    deck2[1] = deck2[2] = deck2[0];
    expect(validateDeck('agents', deck2).errors.join()).toMatch(/copies/);
  });
  it('Poncho set: 8 neutral Base cards (ids 41–48), never in starter decks, legal in any race', () => {
    const poncho = COLLECTIBLE.filter((c) => setOf(c) === 'poncho');
    expect(poncho.map((c) => c.id)).toEqual([41, 42, 43, 44, 45, 46, 47, 48]);
    expect(poncho.every((c) => c.faction === 'neutral' && c.chain === 'base')).toBe(true);
    expect(poncho.filter((c) => c.rarity === 'legendary')).toHaveLength(1);
    for (const r of RACES) {
      expect(starterDeck(r)).toHaveLength(30);
      expect(starterDeck(r).some((id) => id > 40)).toBe(false);
      const deck = starterDeck(r);
      deck.splice(deck.indexOf(34), 2, 41, 41); // Validators → Poncho Kittens
      expect(validateDeck(r, deck, true).errors).toEqual([]);
    }
  });
  it('core set has 40 collectible cards, 8 per race', () => {
    const coll = Array.from({ length: 40 }, (_, i) => card(i + 1));
    for (const r of RACES) expect(coll.filter((c) => c.faction === r)).toHaveLength(8);
    expect(coll.filter((c) => c.faction === 'neutral')).toHaveLength(8);
  });
});

describe('match setup', () => {
  it('is deterministic for the same seed', () => {
    expect(newMatch()).toEqual(newMatch());
    expect(newMatch('agents', 'degens', keccakHex('x'))).not.toEqual(newMatch());
  });
  it('deals opening hands and starts turn 1 with 1 gas', () => {
    const g = newMatch();
    const first = g.active;
    expect(g.turn).toBe(1);
    expect(g.players[first].hand).toHaveLength(4); // 3 + turn draw
    expect(g.players[1 - first].hand).toHaveLength(4);
    expect(g.players[first].gas).toBe(1);
  });
  it('rejects moves out of turn', () => {
    const g = newMatch();
    expect(() => applyAction(g, (1 - g.active) as Seat, { type: 'endTurn' })).toThrow(IllegalAction);
  });
});

describe('combat', () => {
  it('guard must be attacked first', () => {
    const g = newMatch();
    const me = g.active, op = (1 - me) as Seat;
    const atk = unit(g, me, 34);
    const guard = unit(g, op, 33);
    unit(g, op, 34);
    expect(() => applyAction(g, me, { type: 'attack', attacker: atk, target: 'treasury' })).toThrow(/Guard/);
    const r = applyAction(g, me, { type: 'attack', attacker: atk, target: guard });
    const gd = r.state.players[op].board.find((u) => u.uid === guard)!;
    expect(gd.health).toBe(1);
  });
  it('summoning sickness unless Rush', () => {
    const { g, uid } = withHand(newMatch(), 37); // Bridge Runner, rush
    const r = applyAction(g, g.active, { type: 'play', uid });
    expect(legalActions(r.state, g.active).some((a) => a.type === 'attack' && a.attacker === uid)).toBe(true);
    const { g: g2, uid: v } = withHand(newMatch(), 34); // Validator, no rush
    const r2 = applyAction(g2, g2.active, { type: 'play', uid: v });
    expect(legalActions(r2.state, g2.active).some((a) => a.type === 'attack' && a.attacker === v)).toBe(false);
  });
  it('treasury to 0 ends the match', () => {
    const g = newMatch();
    const me = g.active, op = (1 - me) as Seat;
    g.players[op].treasury = 3;
    const u = unit(g, me, 34);
    const r = applyAction(g, me, { type: 'attack', attacker: u, target: 'treasury' });
    expect(r.state.status).toBe('ended');
    expect(r.state.winner).toBe(me);
  });
});

describe('race mechanics', () => {
  it('Firewall pings summoned enemy units', () => {
    const g = newMatch('degens', 'agents');
    const me = g.active, op = (1 - me) as Seat;
    g.players[op].race = 'agents';
    unit(g, op, 4); // Sentry Drone
    const { g: g2, uid } = withHand(g, 25); // Meme Critter 1/1
    const r = applyAction(g2, me, { type: 'play', uid });
    expect(r.state.players[me].board.find((u) => u.uid === uid)).toBeUndefined();
  });
  it('Hold grows units that did not attack', () => {
    let g = newMatch('brokers', 'agents');
    const me = g.active;
    const u = unit(g, me, 17, { summonedTurn: -5 });
    g = applyAction(g, me, { type: 'endTurn' }).state;
    g = applyAction(g, g.active, { type: 'endTurn' }).state;
    const grown = g.players[me].board.find((x) => x.uid === u)!;
    expect(grown.attack).toBe(card(17).attack! + 1);
  });
  it('Deploy summons Drone tokens', () => {
    const { g, uid } = withHand(newMatch(), 5); // Swarm Deployer
    const r = applyAction(g, g.active, { type: 'play', uid });
    expect(r.state.players[g.active].board).toHaveLength(3);
  });
  it('Automate fires at the start of your next turn', () => {
    const base = newMatch();
    const { g, uid } = withHand(base, 3); // Cron Job
    const me = g.active;
    let s = applyAction(g, me, { type: 'play', uid }).state;
    expect(s.players[me].automations).toHaveLength(1);
    s = applyAction(s, me, { type: 'endTurn' }).state;
    const t = s.players[1 - me].treasury;
    s = applyAction(s, s.active, { type: 'endTurn' }).state;
    expect(s.players[me].automations).toHaveLength(0);
    expect(s.players[1 - me].treasury + s.players[1 - me].board.length).toBeLessThanOrEqual(t);
  });
  it('predictions hit and backfire', () => {
    const { g, uid } = withHand(newMatch('prophets', 'agents'), 9); // Tea Leaves
    const me = g.active, op = (1 - me) as Seat;
    let s = applyAction(g, me, { type: 'play', uid, condition: 'attacks' }).state;
    // opponent view hides the condition
    const pv = viewFor(s, op).players[me].predictions[0];
    expect('hidden' in pv).toBe(true);
    s = applyAction(s, me, { type: 'endTurn' }).state;
    const a = unit(s, op, 34, { summonedTurn: 0 });
    const before = s.players[me].treasury;
    s = applyAction(s, op, { type: 'attack', attacker: a, target: 'treasury' }).state;
    const res = applyAction(s, op, { type: 'endTurn' });
    expect(res.events.find((e) => e.t === 'predictionResolved')).toMatchObject({ hit: true });
    expect(res.state.players[op].treasury).toBeLessThan(s.players[op].treasury);
    expect(before).toBeGreaterThan(0);
  });
  it('wrong prediction backfires', () => {
    const { g, uid } = withHand(newMatch('prophets', 'agents'), 15); // Prophecy of Ruin, backfire 3
    const me = g.active;
    let s = applyAction(g, me, { type: 'play', uid, condition: 'plays3Cards' }).state;
    s = applyAction(s, me, { type: 'endTurn' }).state;
    const t = s.players[me].treasury;
    s = applyAction(s, s.active, { type: 'endTurn' }).state;
    expect(s.players[me].treasury).toBe(t - 3);
  });
  it('Rug Pull sacrifices a unit for Treasury damage', () => {
    const g0 = newMatch('degens', 'brokers');
    const me = g0.active;
    const u = unit(g0, me, 34); // 3 attack
    const { g, uid } = withHand(g0, 29);
    const t = g.players[1 - me].treasury;
    const r = applyAction(g, me, { type: 'play', uid, target: u });
    expect(r.state.players[me].board).toHaveLength(0);
    expect(r.state.players[1 - me].treasury).toBe(t - 5);
  });
  it('Portfolio drops Bonds on death', () => {
    const g0 = newMatch('agents', 'brokers');
    const me = g0.active, op = (1 - me) as Seat;
    const pm = unit(g0, op, 21);
    const { g, uid } = withHand(g0, 36); // Liquidator 3 dmg
    const r = applyAction(g, me, { type: 'play', uid, target: pm });
    expect(r.state.players[op].board.map((u) => u.cardId)).toEqual([1001, 1001]);
  });
  it('Ape reduces cost and applies a downside', () => {
    const { g, uid } = withHand(newMatch('degens', 'agents'), 30, 1); // Hype Man cost 3, 1 gas
    const r = applyAction(g, g.active, { type: 'play', uid, ape: true });
    expect(r.events.some((e) => e.t === 'apeDownside')).toBe(true);
  });
});

describe('Poncho set', () => {
  it('Poncho Kitten adds a Taco to your hand; a Taco gives a friendly unit +1/+1 for 1 Gas', () => {
    const { g, uid } = withHand(newMatch(), 41, 3);
    const me = g.active;
    const r = applyAction(g, me, { type: 'play', uid });
    const taco = r.state.players[me].hand.find((h) => h.cardId === TOKEN_TACO)!;
    expect(taco).toBeTruthy();
    expect(r.events.some((e) => e.t === 'create' && e.cardId === TOKEN_TACO)).toBe(true);
    expect(eventsFor(r.events, (1 - me) as Seat).some((e) => e.t === 'create')).toBe(false); // hidden from the opponent
    const kitten = r.state.players[me].board.find((u) => u.cardId === 41)!;
    const r2 = applyAction(r.state, me, { type: 'play', uid: taco.uid, target: kitten.uid });
    const k2 = r2.state.players[me].board.find((u) => u.uid === kitten.uid)!;
    expect([k2.attack, k2.health]).toEqual([2, 2]);
    expect(r2.state.players[me].gas).toBe(1);
  });
  it('Tacos burn when the hand is full', () => {
    const { g, uid } = withHand(newMatch(), 42, 5);
    const me = g.active;
    while (g.players[me].hand.length < HAND_LIMIT) g.players[me].hand.push({ uid: g.nextUid++, cardId: 34 });
    const r = applyAction(g, me, { type: 'play', uid });
    expect(r.state.players[me].hand).toHaveLength(HAND_LIMIT);
    expect(r.events.filter((e) => e.t === 'burn' && e.cardId === TOKEN_TACO)).toHaveLength(1);
  });
  it('Sombrero Sentry leaves a Taco when it dies; Taco Truck makes one each turn', () => {
    const g = structuredClone(newMatch());
    const me = g.active, opp = (1 - me) as Seat;
    const sentry = unit(g, opp, 44, { health: 1 });
    unit(g, opp, 45);
    const atk = unit(g, me, 34, { summonedTurn: -5 });
    const r = applyAction(g, me, { type: 'attack', attacker: atk, target: sentry });
    expect(r.state.players[opp].hand.filter((h) => h.cardId === TOKEN_TACO)).toHaveLength(1);
    const r2 = applyAction(r.state, me, { type: 'endTurn' });
    expect(r2.state.players[opp].hand.filter((h) => h.cardId === TOKEN_TACO)).toHaveLength(2);
  });
});

describe('views & fuzz', () => {
  it('never leaks the opponent hand or deck', () => {
    const g = newMatch();
    const v = viewFor(g, 0);
    expect(v.hand).toEqual(g.players[0].hand);
    expect(JSON.stringify(v)).not.toContain('"deck"');
    const ev = [{ t: 'draw', seat: 1, uid: 1, cardId: 2, private: true } as const];
    expect(eventsFor(ev, 0)).toHaveLength(0);
    expect(eventsFor(ev, 1)).toHaveLength(1);
  });
  it('random bots finish 200 matches with only legal moves', () => {
    let seed = 1;
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 200; i++) {
      const g = newMatch(RACES[i % 4], RACES[(i + 1) % 4], keccakHex('fuzz' + i));
      const end = playOut(g, [randomBot(rng), randomBot(rng)]);
      expect(end.status).toBe('ended');
    }
  });
  it('greedy bot beats random bot most of the time', () => {
    let wins = 0;
    for (let i = 0; i < 20; i++) {
      const end = playOut(newMatch('agents', 'agents', keccakHex('gr' + i)), [greedyBot(), randomBot()]);
      if (end.winner === 0) wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(15);
  });
});

describe('Set 1 · Prophets batch 1', () => {
  it('Augur must target an enemy unit when there is one, and plays untargeted only when there is none', () => {
    const { g, uid } = withHand(newMatch('prophets', 'degens'), 53);
    const me = g.active;
    const op = (1 - me) as Seat;
    g.players[op].board = [];
    const empty = legalActions(g, me).filter((a) => a.type === 'play' && a.uid === uid);
    expect(empty).toEqual([{ type: 'play', uid }]); // no enemy unit: it's just a 4/5
    const target = unit(g, op, 34, { health: 5, maxHealth: 5 });
    const plays = legalActions(g, me).filter((a) => a.type === 'play' && a.uid === uid);
    expect(plays).toEqual([{ type: 'play', uid, target }]); // the damage can't be skipped
    expect(() => applyAction(g, me, { type: 'play', uid })).toThrow(IllegalAction);
    const after = applyAction(g, me, { type: 'play', uid, target }).state;
    expect(after.players[op].board.find((u) => u.uid === target)!.health).toBe(4); // 1 damage without a prediction
  });
});
