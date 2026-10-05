import { card, PREDICTION_TIERS } from './cards.ts';
import { applyAction, effectiveAttack, legalActions, other } from './engine.ts';
import type { Action, Effect, GameState, PredictionCondition, Seat } from './types.ts';

export type Bot = (g: GameState, seat: Seat) => Action;

/** Uniform random legal move (ends turn 20% of the time when other moves exist). */
export function randomBot(rng: () => number = Math.random): Bot {
  return (g, seat) => {
    const acts = legalActions(g, seat);
    const nonEnd = acts.filter((a) => a.type !== 'endTurn');
    if (!nonEnd.length || rng() < 0.2) return { type: 'endTurn' };
    return nonEnd[Math.floor(rng() * nonEnd.length)];
  };
}

/**
 * Estimated chance the opponent satisfies `cond` on their next turn (public info only). Fitted to what greedy bots
 * actually do (about 20,000 opponent turns over pool decks), by the opponent's race, board, next turn's Gas and hand.
 */
export function predictionOdds(g: GameState, seat: Seat, cond: PredictionCondition): number {
  const op = g.players[other(seat)];
  const units = op.board.length;
  const gas = Math.min(10, op.maxGas + 1);
  const hand = op.hand.length;
  switch (cond) {
    case 'attacks':
      if (!units) return op.race === 'degens' ? 0.24 : 0.07; // Rush
      return op.race === 'brokers' && units === 1 ? 0.72 : 0.87;
    case 'attacks2':
      if (units >= 2) return op.race === 'brokers' ? 0.75 : 0.83;
      return units === 1 ? (op.race === 'degens' ? 0.2 : 0.07) : 0;
    case 'playsBigUnit':
      if (gas < 4) return op.race === 'degens' ? 0.08 : 0.02;
      return Math.min(0.9, (hand <= 1 ? 0.38 : hand <= 3 ? 0.52 : hand <= 5 ? 0.6 : 0.75) + (op.race === 'brokers' ? 0.1 : 0));
    case 'plays3Cards':
      if (gas < 4) return 0.01;
      if (gas < 6) return 0.04;
      return op.race === 'prophets' ? 0.28 : 0.17;
    case 'summons3':
      if (op.race === 'agents') return gas < 4 ? 0.05 : 0.2;
      return gas >= 6 ? (op.race === 'degens' ? 0.03 : 0.07) : 0.01;
  }
}

/** Rough worth of effects that fire for `seat` (trigger payoffs), in evaluation units. */
function effectsValue(g: GameState, seat: Seat, effects: Effect[]): number {
  const units = g.players[seat].board.length;
  let v = 0;
  for (const e of effects) {
    switch (e.k) {
      case 'damage':
        v += e.n * (e.to === 'enemyTreasury' ? 1.4 : e.to === 'randomEnemyUnitOrTreasury' ? 1.2 : e.to === 'allEnemyUnits' ? 1.5 : 0.8);
        break;
      case 'draw': case 'drawIfPrediction': v += e.n; break;
      case 'buff': v += (e.atk * 1.2 + e.hp * 0.9) * (e.to === 'allFriendly' ? units : 1); break;
      case 'deploy': v += e.n * 2.1; break;
      case 'pump': v += 2 * (e.to === 'allFriendly' ? units : 1); break;
      default: break;
    }
  }
  return v;
}

/**
 * Expected value of an active prediction, in evaluation units: its own payoff, plus the units on your board that
 * pay off whenever one of your predictions comes true (Street Oracle, The Long Bet, Seers' Circle…).
 */
export function predictionEV(g: GameState, seat: Seat, cardId: number, cond: PredictionCondition): number {
  const pay = card(cardId).prediction!;
  const me = g.players[seat];
  const p = predictionOdds(g, seat, cond);
  const bonus = me.board.some((u) => u.keywords.includes('predictionBonus')) ? 1 : 0;
  const tier = PREDICTION_TIERS[cond] + bonus;
  const noBackfire = me.board.some((u) => u.keywords.includes('noBackfire'));
  const triggers = me.board.reduce((acc, u) => {
    const fx = card(u.cardId).onPredictionHit;
    return fx ? acc + effectsValue(g, seat, fx) : acc;
  }, 0);
  const win = tier * ((pay.damagePerTier ?? 0) * 1.4 + (pay.drawPerTier ?? 0) * 1.0) + triggers;
  return p * win - (noBackfire ? 0 : (1 - p) * pay.backfire * 1.4);
}

/** Static evaluation from `seat`'s perspective. */
export function evaluate(g: GameState, seat: Seat): number {
  if (g.status === 'ended') return g.winner === seat ? 1e6 : g.winner === 'draw' ? 0 : -1e6;
  const me = g.players[seat];
  const op = g.players[other(seat)];
  const boardVal = (s: Seat) =>
    g.players[s].board.reduce((acc, u) => {
      let v = effectiveAttack(g, s, u) * 1.2 + u.health * 0.9;
      if (u.keywords.includes('guard')) v += 1;
      // Hold: a unit that skips attacking grows next turn (and pays its Dividend), so attacking with it costs that.
      if (u.keywords.includes('hold')) v += u.attackedLastOwnTurn ? 0.3 : 1.3;
      if (u.keywords.includes('firewall')) v += 1.2;
      const c = card(u.cardId);
      if (c.startOfTurn || c.dividend) v += 1.5;
      if (c.onPredictionHit) v += 0.75; // pays off on future predictions too
      if (c.portfolio) v += c.portfolio.length * 1.5;
      return acc + v;
    }, 0);
  const predVal = (s: Seat) =>
    g.players[s].predictions.reduce((acc, p) => acc + predictionEV(g, s, p.cardId, p.condition), 0);
  const treasuryVal = (t: number) => t * 1.4 + (t <= 8 ? (t - 8) * 1.5 : 0);
  return (
    treasuryVal(me.treasury) - treasuryVal(op.treasury)
    + boardVal(seat) - boardVal(other(seat))
    + me.hand.length * 1.0 - op.hand.length * 0.5
    + me.assets.length * 3 + me.automations.length * 2.5
    + me.discount * 0.7 // Compute: the next card is cheaper
    + predVal(seat)
  );
}

/** Moves whose payoff is the move after them: extra Gas, Compute, and buffs, Rush or Pump on a chosen unit. */
function isEnabler(g: GameState, seat: Seat, a: Action): boolean {
  if (a.type !== 'play') return false;
  const h = g.players[seat].hand.find((x) => x.uid === a.uid);
  const c = h && card(h.cardId);
  if (!c || c.type === 'unit') return false;
  return (c.onPlay ?? []).some((e) => e.k === 'gainGas' || e.k === 'compute' || e.k === 'grantRush' || e.k === 'doubleAttack'
    || ((e.k === 'buff' || e.k === 'pump') && e.to === 'chosen'));
}

/** How many of the best first moves also get a second look. */
const LOOKAHEAD_TOP = 3;

/**
 * Greedy with a short look within the turn: try every legal action and evaluate the result. The best few, and every
 * enabler (extra Gas, Compute, a buff or Rush on a unit), are also scored by the best follow-up move they allow, so
 * the bot sees why Flash Loan or FOMO is worth playing. Ends the turn when nothing beats passing. Deterministic given
 * the state.
 */
export function greedyBot(): Bot {
  return (g, seat) => {
    const pass = evaluate(g, seat) + 0.01;
    const first: { a: Action; s: GameState; score: number }[] = [];
    for (const a of legalActions(g, seat)) {
      if (a.type === 'endTurn') continue;
      try {
        const s = applyAction(g, seat, a).state;
        first.push({ a, s, score: evaluate(s, seat) });
      } catch { continue; }
    }
    const top = new Set([...first].sort((x, y) => y.score - x.score).slice(0, LOOKAHEAD_TOP));
    let best: Action = { type: 'endTurn' };
    let bestScore = pass;
    for (const f of first) {
      let score = f.score;
      if ((top.has(f) || isEnabler(g, seat, f.a)) && f.s.status === 'active' && f.s.active === seat) {
        for (const b of legalActions(f.s, seat)) {
          if (b.type === 'endTurn') continue;
          try { score = Math.max(score, evaluate(applyAction(f.s, seat, b).state, seat)); } catch { continue; }
        }
      }
      if (score > bestScore) { bestScore = score; best = f.a; }
    }
    return best;
  };
}

/** Play a full bot-vs-bot match; returns the final state. */
export function playOut(g: GameState, bots: [Bot, Bot], maxActions = 2000): GameState {
  let s = g;
  for (let i = 0; i < maxActions && s.status === 'active'; i++) {
    const seat = s.active;
    s = applyAction(s, seat, bots[seat](s, seat)).state;
  }
  return s;
}
