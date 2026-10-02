import { card, PREDICTION_TIERS, TOKEN_DRONE, validateDeck } from './cards.ts';
import { keccakHex, randWord, shuffle } from './rng.ts';
import type {
  Action, CardDef, Effect, GameEvent, GameState, HandCard, MatchConfig, PlayerState, Race,
  PredictionCondition, Seat, UnitState,
} from './types.ts';

// ─── Match constants (starting values for playtesting) ───────────
export const STARTING_TREASURY = 25;
export const MAX_GAS = 10;
export const BOARD_SLOTS = 5;
export const ASSET_SLOTS = 3;
export const HAND_LIMIT = 10;
export const OPENING_HAND = [3, 4] as const; // first player, second player
/** Half-turn cap; at the cap the higher Treasury wins. */
export const TURN_LIMIT = 40;
export const DIVIDEND_CAP = 2;
export const APE_DISCOUNT = 2;
export const PREDICTION_CONDITIONS: PredictionCondition[] = ['attacks', 'attacks2', 'playsBigUnit', 'plays3Cards', 'summons3'];

export class IllegalAction extends Error {}

export interface ApplyResult { state: GameState; events: GameEvent[] }

// ─── Setup ───────────────────────────────────────────────────────
export function createMatch(cfg: MatchConfig): ApplyResult {
  cfg.players.forEach((p, i) => {
    const check = validateDeck(p.race, p.deck, false);
    if (!check.ok) throw new IllegalAction(`player ${i} deck invalid: ${check.errors.join('; ')}`);
  });
  const mk = (i: 0 | 1): PlayerState => {
    const p = cfg.players[i];
    return {
      address: p.address.toLowerCase(),
      race: p.race,
      treasury: STARTING_TREASURY,
      gas: 0,
      maxGas: 0,
      deck: shuffle(p.deck, keccakHex(cfg.seed, p.address.toLowerCase(), p.deckSalt)),
      hand: [], board: [], assets: [], predictions: [], automations: [], graveyard: [],
      fatigue: 0, discount: 0, dividendsThisTurn: 0, stats: emptyStats(),
    };
  };
  const g: GameState = {
    version: 1,
    matchId: cfg.matchId,
    seed: cfg.seed,
    turn: 0,
    active: 0,
    players: [mk(0), mk(1)],
    rngCounter: 0,
    nextUid: 1,
    status: 'active',
    winner: null,
  };
  const ev: GameEvent[] = [];
  const first = (rand(g) % 2) as Seat;
  for (let n = 0; n < OPENING_HAND[0]; n++) draw(g, first, ev);
  for (let n = 0; n < OPENING_HAND[1]; n++) draw(g, other(first), ev);
  startTurn(g, first, ev);
  return { state: g, events: ev };
}

/**
 * A scripted match for the tutorial: decks are drawn in the given order (no shuffle), `first` moves first,
 * and Treasuries can start lower so the lesson stays short. Never used for real matches (no seed fairness).
 */
export function createScriptedMatch(cfg: {
  matchId: string; players: [{ address: string; race: Race; deck: number[] }, { address: string; race: Race; deck: number[] }];
  first: Seat; treasury?: [number, number];
}): ApplyResult {
  const mk = (i: 0 | 1): PlayerState => ({
    address: cfg.players[i].address.toLowerCase(), race: cfg.players[i].race,
    treasury: cfg.treasury?.[i] ?? STARTING_TREASURY, gas: 0, maxGas: 0, deck: [...cfg.players[i].deck],
    hand: [], board: [], assets: [], predictions: [], automations: [], graveyard: [],
    fatigue: 0, discount: 0, dividendsThisTurn: 0, stats: emptyStats(),
  });
  const g: GameState = {
    version: 1, matchId: cfg.matchId, seed: keccakHex('scripted', cfg.matchId), turn: 0, active: cfg.first,
    players: [mk(0), mk(1)], rngCounter: 0, nextUid: 1, status: 'active', winner: null,
  };
  const ev: GameEvent[] = [];
  for (let n = 0; n < OPENING_HAND[0]; n++) draw(g, cfg.first, ev);
  for (let n = 0; n < OPENING_HAND[1]; n++) draw(g, other(cfg.first), ev);
  startTurn(g, cfg.first, ev);
  return { state: g, events: ev };
}

function emptyStats() { return { cardsPlayed: 0, unitsSummoned: 0, bigUnitsPlayed: 0, attackers: [] as number[] }; }

export const other = (s: Seat): Seat => (s === 0 ? 1 : 0);

function rand(g: GameState): number { return randWord(g.seed, 0x10000 + g.rngCounter++); }

// ─── Public API ──────────────────────────────────────────────────
export function applyAction(state: GameState, seat: Seat, action: Action): ApplyResult {
  if (state.status !== 'active') throw new IllegalAction('match is over');
  const g: GameState = structuredClone(state);
  const ev: GameEvent[] = [];
  if (action.type === 'concede') {
    finish(g, other(seat), 'concede', ev);
    return { state: g, events: ev };
  }
  if (seat !== g.active) throw new IllegalAction('not your turn');
  switch (action.type) {
    case 'play': play(g, seat, action, ev); break;
    case 'attack': attack(g, seat, action.attacker, action.target, ev); break;
    case 'endTurn': endTurn(g, ev); break;
    default: throw new IllegalAction('unknown action');
  }
  return { state: g, events: ev };
}

/** Referee-only: end the match because a player ran out of time or abandoned. */
export function forfeit(state: GameState, loser: Seat): ApplyResult {
  const g: GameState = structuredClone(state);
  const ev: GameEvent[] = [];
  if (g.status === 'active') finish(g, other(loser), 'timeout', ev);
  return { state: g, events: ev };
}

export function effectiveAttack(g: GameState, seat: Seat, u: UnitState): number {
  if (!u.keywords.includes('swarm')) return u.attack;
  const others = g.players[seat].board.filter((x) => x.uid !== u.uid && x.keywords.includes('swarm')).length;
  return u.attack + others;
}

export function playCost(g: GameState, seat: Seat, h: HandCard, ape = false): number {
  const c = card(h.cardId);
  return Math.max(0, c.cost - g.players[seat].discount - (ape ? APE_DISCOUNT : 0));
}

export function canAttack(g: GameState, seat: Seat, u: UnitState): boolean {
  if (u.attacksThisTurn > 0) return false;
  if (effectiveAttack(g, seat, u) <= 0) return false;
  return u.summonedTurn < g.turn || u.keywords.includes('rush') || u.rushThisTurn;
}

export function attackTargets(g: GameState, seat: Seat): (number | 'treasury')[] {
  const enemy = g.players[other(seat)].board;
  const guards = enemy.filter((u) => u.keywords.includes('guard'));
  if (guards.length) return guards.map((u) => u.uid);
  return [...enemy.map((u) => u.uid), 'treasury'];
}

export function hasActivePrediction(g: GameState, seat: Seat): boolean {
  return g.players[seat].predictions.length > 0;
}

/** Every legal action for `seat` (concede excluded). */
export function legalActions(g: GameState, seat: Seat): Action[] {
  if (g.status !== 'active' || g.active !== seat) return [];
  const me = g.players[seat];
  const out: Action[] = [];
  for (const h of me.hand) {
    const c = card(h.cardId);
    for (const ape of c.keywords.includes('ape') ? [false, true] : [false]) {
      if (playCost(g, seat, h, ape) > me.gas) continue;
      if (c.type === 'unit' && me.board.length >= BOARD_SLOTS) continue;
      if (c.type === 'asset' && me.assets.length >= ASSET_SLOTS) continue;
      const base = { type: 'play' as const, uid: h.uid, ...(ape ? { ape: true } : {}) };
      if (c.type === 'prediction') {
        for (const condition of PREDICTION_CONDITIONS) out.push({ ...base, condition });
      } else if (c.target) {
        const targets = validTargets(g, seat, c);
        for (const t of targets) out.push({ ...base, target: t });
        if (c.targetOptional || (!targets.length && c.type === 'unit')) out.push(base);
      } else out.push(base);
    }
  }
  for (const u of me.board) {
    if (!canAttack(g, seat, u)) continue;
    for (const t of attackTargets(g, seat)) out.push({ type: 'attack', attacker: u.uid, target: t });
  }
  out.push({ type: 'endTurn' });
  return out;
}

function validTargets(g: GameState, seat: Seat, c: CardDef): number[] {
  const mine = g.players[seat].board.map((u) => u.uid);
  const theirs = g.players[other(seat)].board.map((u) => u.uid);
  switch (c.target) {
    case 'friendlyUnit': return mine;
    case 'enemyUnit': return theirs;
    case 'anyUnit': return [...mine, ...theirs];
    default: return [];
  }
}

// ─── Turn flow ───────────────────────────────────────────────────
function startTurn(g: GameState, seat: Seat, ev: GameEvent[]) {
  g.turn += 1;
  g.active = seat;
  const me = g.players[seat];
  me.stats = emptyStats();
  me.dividendsThisTurn = 0;
  me.maxGas = Math.min(MAX_GAS, me.maxGas + 1);
  me.gas = me.maxGas;
  ev.push({ t: 'turnStart', seat, turn: g.turn });
  draw(g, seat, ev);
  if (g.status !== 'active') return;

  // Hold: units that sat through your whole previous turn without attacking grow.
  for (const u of me.board) {
    const held = u.keywords.includes('hold') && u.summonedTurn < g.turn - 2 && !u.attackedLastOwnTurn;
    u.attacksThisTurn = 0;
    u.rushThisTurn = false;
    u.attackedLastOwnTurn = false;
    if (!held) continue;
    u.attack += 1; u.health += 1; u.maxHealth += 1;
    ev.push({ t: 'hold', seat, uid: u.uid });
    const div = card(u.cardId).dividend;
    if (div && me.dividendsThisTurn < DIVIDEND_CAP) {
      me.dividendsThisTurn++;
      runEffects(g, seat, div, { self: u.uid }, ev);
    }
  }

  // Automate: queued effects fire even if you pass.
  const queued = me.automations;
  me.automations = [];
  for (const effects of queued) {
    ev.push({ t: 'automate', seat });
    runEffects(g, seat, effects, {}, ev);
  }

  for (const u of me.board.slice()) {
    const sot = card(u.cardId).startOfTurn;
    if (sot && me.board.includes(u)) runEffects(g, seat, sot, { self: u.uid }, ev);
  }
  cleanup(g, ev);
}

function endTurn(g: GameState, ev: GameEvent[]) {
  const seat = g.active;
  const opp = other(seat);
  // Resolve the opponent's predictions about the turn that just ended.
  const pending = g.players[opp].predictions.filter((p) => p.resolvesOnTurn === g.turn);
  g.players[opp].predictions = g.players[opp].predictions.filter((p) => p.resolvesOnTurn !== g.turn);
  for (const p of pending) resolvePrediction(g, opp, p.uid, p.cardId, p.condition, ev);
  cleanup(g, ev);
  if (g.status !== 'active') return;
  if (g.turn >= TURN_LIMIT) {
    const [a, b] = g.players.map((p) => p.treasury);
    finish(g, a === b ? 'draw' : a > b ? 0 : 1, 'turnLimit', ev);
    return;
  }
  startTurn(g, opp, ev);
}

export function predictionHit(g: GameState, target: Seat, cond: PredictionCondition): boolean {
  const s = g.players[target].stats;
  switch (cond) {
    case 'attacks': return s.attackers.length >= 1;
    case 'attacks2': return new Set(s.attackers).size >= 2;
    case 'playsBigUnit': return s.bigUnitsPlayed >= 1;
    case 'plays3Cards': return s.cardsPlayed >= 3;
    case 'summons3': return s.unitsSummoned >= 3;
  }
}

function resolvePrediction(g: GameState, seat: Seat, uid: number, cardId: number, cond: PredictionCondition, ev: GameEvent[]) {
  const me = g.players[seat];
  const hit = predictionHit(g, other(seat), cond);
  ev.push({ t: 'predictionResolved', seat, uid, cardId, condition: cond, hit });
  const payoff = card(cardId).prediction!;
  if (hit) {
    const bonus = me.board.some((u) => u.keywords.includes('predictionBonus')) ? 1 : 0;
    const tier = PREDICTION_TIERS[cond] + bonus;
    if (payoff.damagePerTier) damageTreasury(g, other(seat), payoff.damagePerTier * tier, ev);
    for (let i = 0; i < (payoff.drawPerTier ?? 0) * tier; i++) draw(g, seat, ev);
    for (const u of me.board.slice()) {
      const hitFx = card(u.cardId).onPredictionHit;
      if (hitFx) runEffects(g, seat, hitFx, { self: u.uid }, ev);
    }
  } else if (!me.board.some((u) => u.keywords.includes('noBackfire'))) {
    damageTreasury(g, seat, payoff.backfire, ev);
  }
}

function draw(g: GameState, seat: Seat, ev: GameEvent[]) {
  const me = g.players[seat];
  const id = me.deck.shift();
  if (id === undefined) {
    me.fatigue += 1;
    ev.push({ t: 'fatigue', seat, n: me.fatigue });
    damageTreasury(g, seat, me.fatigue, ev);
    return;
  }
  if (me.hand.length >= HAND_LIMIT) {
    me.graveyard.push(id);
    ev.push({ t: 'burn', seat, cardId: id });
    return;
  }
  const uid = g.nextUid++;
  me.hand.push({ uid, cardId: id });
  ev.push({ t: 'draw', seat, uid, cardId: id, private: true });
}

// ─── Playing cards ───────────────────────────────────────────────
function play(g: GameState, seat: Seat, a: Extract<Action, { type: 'play' }>, ev: GameEvent[]) {
  const me = g.players[seat];
  const idx = me.hand.findIndex((h) => h.uid === a.uid);
  if (idx < 0) throw new IllegalAction('card not in hand');
  const h = me.hand[idx];
  const c = card(h.cardId);
  const ape = !!a.ape;
  if (ape && !c.keywords.includes('ape')) throw new IllegalAction(`${c.name} has no Ape`);
  const cost = playCost(g, seat, h, ape);
  if (cost > me.gas) throw new IllegalAction('not enough Gas');
  if (c.type === 'unit' && me.board.length >= BOARD_SLOTS) throw new IllegalAction('board is full');
  if (c.type === 'asset' && me.assets.length >= ASSET_SLOTS) throw new IllegalAction('asset slots are full');
  let target: number | undefined;
  if (c.target) {
    const valid = validTargets(g, seat, c);
    if (typeof a.target === 'number') {
      if (!valid.includes(a.target)) throw new IllegalAction('invalid target');
      target = a.target;
    } else if (!(c.targetOptional || (c.type === 'unit' && !valid.length))) {
      throw new IllegalAction('target required');
    }
  }
  if (c.type === 'prediction' && (!a.condition || !PREDICTION_CONDITIONS.includes(a.condition))) {
    throw new IllegalAction('prediction needs a condition');
  }

  me.gas -= cost;
  me.discount = 0;
  me.hand.splice(idx, 1);
  me.stats.cardsPlayed += 1;
  ev.push({ t: 'play', seat, cardId: c.id, uid: h.uid, ...(ape ? { ape } : {}) });

  let self: number | undefined;
  switch (c.type) {
    case 'unit': {
      if (c.cost >= 4) me.stats.bigUnitsPlayed += 1;
      self = summon(g, seat, c.id, ev, h.uid);
      break;
    }
    case 'asset':
      me.assets.push({ uid: h.uid, cardId: c.id });
      break;
    case 'prediction':
      me.predictions.push({ uid: h.uid, cardId: c.id, condition: a.condition!, resolvesOnTurn: g.turn + 1 });
      ev.push({ t: 'predictionMade', seat, uid: h.uid, cardId: c.id, condition: a.condition!, private: true });
      break;
    case 'action':
      me.graveyard.push(c.id);
      break;
  }
  if (c.onPlay) runEffects(g, seat, c.onPlay, { self, target }, ev);
  if (ape) apeDownside(g, seat, self, ev);
  cleanup(g, ev);
}

function apeDownside(g: GameState, seat: Seat, self: number | undefined, ev: GameEvent[]) {
  const me = g.players[seat];
  const roll = rand(g) % 3;
  const unit = self !== undefined ? me.board.find((u) => u.uid === self) : undefined;
  if (roll === 1 && me.hand.length) {
    const [lost] = me.hand.splice(rand(g) % me.hand.length, 1);
    me.graveyard.push(lost.cardId);
    ev.push({ t: 'apeDownside', seat, kind: 'discard' });
  } else if (roll === 2 && unit) {
    unit.health -= 1; unit.maxHealth -= 1;
    ev.push({ t: 'apeDownside', seat, kind: 'fragile' });
    ev.push({ t: 'stat', seat, uid: unit.uid, attack: unit.attack, health: unit.health });
  } else {
    ev.push({ t: 'apeDownside', seat, kind: 'treasury' });
    damageTreasury(g, seat, 2, ev);
  }
}

function summon(g: GameState, seat: Seat, cardId: number, ev: GameEvent[], uid?: number): number | undefined {
  const me = g.players[seat];
  if (me.board.length >= BOARD_SLOTS) return undefined;
  const c = card(cardId);
  const u: UnitState = {
    uid: uid ?? g.nextUid++,
    cardId,
    attack: c.attack ?? 0,
    health: c.health ?? 1,
    maxHealth: c.health ?? 1,
    keywords: [...c.keywords],
    summonedTurn: g.turn,
    attacksThisTurn: 0,
    attackedLastOwnTurn: false,
    rushThisTurn: false,
  };
  me.board.push(u);
  me.stats.unitsSummoned += 1;
  ev.push({ t: 'summon', seat, uid: u.uid, cardId });
  // Firewall: each enemy firewall source pings the new unit.
  const enemy = g.players[other(seat)];
  const firewalls = enemy.board.filter((x) => x.keywords.includes('firewall')).length
    + enemy.assets.filter((x) => card(x.cardId).keywords.includes('firewall')).length;
  for (let i = 0; i < firewalls; i++) damageUnit(g, seat, u, 1, ev);
  return u.uid;
}

// ─── Combat ──────────────────────────────────────────────────────
function attack(g: GameState, seat: Seat, attackerUid: number, target: number | 'treasury', ev: GameEvent[]) {
  const me = g.players[seat];
  const opp = other(seat);
  const u = me.board.find((x) => x.uid === attackerUid);
  if (!u) throw new IllegalAction('attacker not on your board');
  if (!canAttack(g, seat, u)) throw new IllegalAction('unit cannot attack now');
  if (!attackTargets(g, seat).includes(target)) throw new IllegalAction('invalid attack target (Guard?)');
  const atk = effectiveAttack(g, seat, u);
  u.attacksThisTurn += 1;
  u.attackedLastOwnTurn = true;
  me.stats.attackers.push(u.uid);
  ev.push({ t: 'attack', seat, attacker: u.uid, target });
  if (target === 'treasury') {
    damageTreasury(g, opp, atk, ev);
  } else {
    const d = g.players[opp].board.find((x) => x.uid === target)!;
    const back = effectiveAttack(g, opp, d);
    damageUnit(g, opp, d, atk, ev);
    damageUnit(g, seat, u, back, ev);
  }
  cleanup(g, ev);
}

function damageUnit(_g: GameState, seat: Seat, u: UnitState, n: number, ev: GameEvent[]) {
  if (n <= 0) return;
  u.health -= n;
  ev.push({ t: 'damage', seat, uid: u.uid, n });
}

function damageTreasury(g: GameState, seat: Seat, n: number, ev: GameEvent[]) {
  if (n <= 0) return;
  g.players[seat].treasury -= n;
  ev.push({ t: 'damage', seat, uid: 'treasury', n });
}

/** Remove dead units (resolving death triggers), then check for a winner. */
function cleanup(g: GameState, ev: GameEvent[]) {
  for (let guard = 0; guard < 50; guard++) {
    let changed = false;
    for (const seat of [g.active, other(g.active)] as Seat[]) {
      const p = g.players[seat];
      const dead = p.board.filter((u) => u.health <= 0);
      if (!dead.length) continue;
      changed = true;
      p.board = p.board.filter((u) => u.health > 0);
      for (const u of dead) {
        const c = card(u.cardId);
        if (c.collectible) p.graveyard.push(u.cardId);
        ev.push({ t: 'death', seat, uid: u.uid, cardId: u.cardId });
        if (c.onDeath) runEffects(g, seat, c.onDeath, {}, ev);
        for (const tok of c.portfolio ?? []) summon(g, seat, tok, ev);
      }
    }
    if (!changed) break;
  }
  if (g.status !== 'active') return;
  const [a, b] = g.players.map((p) => p.treasury <= 0);
  if (a && b) finish(g, 'draw', 'treasury', ev);
  else if (a) finish(g, 1, 'treasury', ev);
  else if (b) finish(g, 0, 'treasury', ev);
}

function finish(g: GameState, winner: Seat | 'draw', reason: GameState['endReason'], ev: GameEvent[]) {
  g.status = 'ended';
  g.winner = winner;
  g.endReason = reason;
  ev.push({ t: 'gameOver', winner, reason: reason! });
}

// ─── Effects ─────────────────────────────────────────────────────
interface Ctx { self?: number; target?: number }

function unitsFor(g: GameState, seat: Seat, spec: string, ctx: Ctx): { seat: Seat; u: UnitState }[] {
  const mine = g.players[seat].board.map((u) => ({ seat, u }));
  const theirs = g.players[other(seat)].board.map((u) => ({ seat: other(seat), u }));
  switch (spec) {
    case 'self': return mine.filter((x) => x.u.uid === ctx.self);
    case 'chosen': return [...mine, ...theirs].filter((x) => x.u.uid === ctx.target);
    case 'allFriendly': return mine;
    case 'allFriendlySwarm': return mine.filter((x) => x.u.keywords.includes('swarm'));
    case 'allEnemyUnits': return theirs;
    case 'allUnits': return [...mine, ...theirs];
    default: return [];
  }
}

function runEffects(g: GameState, seat: Seat, effects: Effect[], ctx: Ctx, ev: GameEvent[]) {
  const me = g.players[seat];
  const opp = other(seat);
  for (const e of effects) {
    if (g.status !== 'active') return;
    switch (e.k) {
      case 'damage': {
        const n = e.nIfPrediction !== undefined && hasActivePrediction(g, seat) ? e.nIfPrediction : e.n;
        if (e.to === 'enemyTreasury') damageTreasury(g, opp, n, ev);
        else if (e.to === 'ownTreasury') damageTreasury(g, seat, n, ev);
        else if (e.to === 'randomEnemyUnitOrTreasury') {
          const enemy = g.players[opp].board;
          if (enemy.length) damageUnit(g, opp, enemy[rand(g) % enemy.length], n, ev);
          else damageTreasury(g, opp, n, ev);
        } else for (const x of unitsFor(g, seat, e.to, ctx)) damageUnit(g, x.seat, x.u, n, ev);
        break;
      }
      case 'draw': for (let i = 0; i < e.n; i++) draw(g, seat, ev); break;
      case 'drawIfPrediction': if (hasActivePrediction(g, seat)) for (let i = 0; i < e.n; i++) draw(g, seat, ev); break;
      case 'gainGas': me.gas += e.n; break;
      case 'compute': me.discount += e.n; break;
      case 'deploy': for (let i = 0; i < e.n; i++) summon(g, seat, e.token ?? TOKEN_DRONE, ev); break;
      case 'buff':
        for (const x of unitsFor(g, seat, e.to, ctx)) {
          x.u.attack += e.atk; x.u.health += e.hp; x.u.maxHealth += e.hp;
          for (const k of e.addKeywords ?? []) if (!x.u.keywords.includes(k)) x.u.keywords.push(k);
          ev.push({ t: 'stat', seat: x.seat, uid: x.u.uid, attack: x.u.attack, health: x.u.health });
        }
        break;
      case 'pump':
        for (const x of unitsFor(g, seat, e.to, ctx)) {
          const total = 1 + (rand(g) % 3);
          const atk = rand(g) % (total + 1);
          x.u.attack += atk; x.u.health += total - atk; x.u.maxHealth += total - atk;
          ev.push({ t: 'stat', seat: x.seat, uid: x.u.uid, attack: x.u.attack, health: x.u.health });
        }
        break;
      case 'doubleAttack':
        for (const x of unitsFor(g, seat, e.to, ctx)) {
          x.u.attack *= 2;
          ev.push({ t: 'stat', seat: x.seat, uid: x.u.uid, attack: x.u.attack, health: x.u.health });
        }
        break;
      case 'grantRush':
        for (const x of unitsFor(g, seat, e.to, ctx)) x.u.rushThisTurn = true;
        break;
      case 'rug': {
        const victim = me.board.find((u) => u.uid === ctx.target);
        if (!victim) break;
        const dmg = effectiveAttack(g, seat, victim) + e.bonus;
        victim.health = 0;
        damageTreasury(g, opp, dmg, ev);
        break;
      }
      case 'automate': me.automations.push(e.effects); break;
      case 'addToHand':
        for (let i = 0; i < e.n; i++) {
          if (me.hand.length >= HAND_LIMIT) { ev.push({ t: 'burn', seat, cardId: e.card }); continue; }
          const uid = g.nextUid++;
          me.hand.push({ uid, cardId: e.card });
          ev.push({ t: 'create', seat, uid, cardId: e.card, private: true });
        }
        break;
    }
  }
}
