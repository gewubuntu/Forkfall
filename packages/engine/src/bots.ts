import { card, PREDICTION_TIERS } from './cards.ts';
import { applyAction, effectiveAttack, legalActions, other } from './engine.ts';
import type { Action, GameState, PredictionCondition, Seat } from './types.ts';

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

/** Estimated chance the opponent satisfies `cond` on their next turn (public info only). */
export function predictionOdds(g: GameState, seat: Seat, cond: PredictionCondition): number {
  const op = g.players[other(seat)];
  const units = op.board.length;
  const nextGas = Math.min(10, op.maxGas + 1);
  const passive = op.race === 'brokers';
  const handCount = op.hand.length;
  switch (cond) {
    case 'attacks': return units ? (passive ? 0.55 : 0.9) : 0.3;
    case 'attacks2': return units >= 2 ? (passive ? 0.35 : 0.7) : units === 1 ? 0.25 : 0.05;
    case 'playsBigUnit': return nextGas >= 4 && handCount >= 2 ? 0.45 : 0.03;
    case 'plays3Cards': return handCount >= 4 ? (op.race === 'degens' ? 0.45 : 0.2) : 0.05;
    case 'summons3': return op.race === 'agents' ? (nextGas >= 4 ? 0.5 : 0.25) : op.race === 'degens' ? 0.25 : 0.05;
  }
}

/** Expected value of an active prediction, in evaluation units. */
export function predictionEV(g: GameState, seat: Seat, cardId: number, cond: PredictionCondition): number {
  const pay = card(cardId).prediction!;
  const me = g.players[seat];
  const p = predictionOdds(g, seat, cond);
  const bonus = me.board.some((u) => u.keywords.includes('predictionBonus')) ? 1 : 0;
  const tier = PREDICTION_TIERS[cond] + bonus;
  const noBackfire = me.board.some((u) => u.keywords.includes('noBackfire'));
  const win = tier * ((pay.damagePerTier ?? 0) * 1.4 + (pay.drawPerTier ?? 0) * 1.0);
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
      if (u.keywords.includes('hold')) v += 0.8;
      if (u.keywords.includes('firewall')) v += 1.2;
      const c = card(u.cardId);
      if (c.startOfTurn || c.dividend) v += 1.5;
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
    + predVal(seat)
  );
}

/**
 * One-ply greedy: try every legal action, keep the best evaluation.
 * Ends the turn when nothing beats passing. Deterministic given the state.
 */
export function greedyBot(): Bot {
  return (g, seat) => {
    let best: Action = { type: 'endTurn' };
    let bestScore = evaluate(g, seat) + 0.01;
    for (const a of legalActions(g, seat)) {
      if (a.type === 'endTurn') continue;
      let score: number;
      try { score = evaluate(applyAction(g, seat, a).state, seat); } catch { continue; }
      if (score > bestScore) { bestScore = score; best = a; }
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
