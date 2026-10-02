import { useEffect, useState } from 'react';
import type { GameEvent } from '@forkfall/engine';

export interface SideSummary { damage: number; treasuryDamage: number; kills: number; cardsPlayed: number; biggestHit: number }
export interface MatchSummary { sides: [SideSummary, SideSummary]; mvp: [Mvp | null, Mvp | null] }
export interface Mvp { cardId: number; damage: number }

/**
 * Post-match numbers from the event stream: damage dealt (to units and Treasury), units destroyed,
 * cards played, biggest single hit, and each side's MVP: the card that dealt the most damage, counting
 * a unit's attacks and a spell's direct damage. Only events the viewer saw are used.
 */
export function summarize(events: GameEvent[]): MatchSummary {
  const empty = (): SideSummary => ({ damage: 0, treasuryDamage: 0, kills: 0, cardsPlayed: 0, biggestHit: 0 });
  const sides: [SideSummary, SideSummary] = [empty(), empty()];
  const cardOf = new Map<number, number>();
  const tally: [Map<number, number>, Map<number, number>] = [new Map(), new Map()];
  let source: { seat: 0 | 1; cardId: number } | null = null;
  // Fatigue, Ape downsides and backfires hurt your own Treasury: not damage dealt by the opponent.
  let selfHarm: 0 | 1 | null = null;
  for (const e of events) {
    switch (e.t) {
      case 'fatigue': selfHarm = e.seat; break;
      case 'apeDownside': if (e.kind === 'treasury') selfHarm = e.seat; break;
      case 'predictionResolved': if (!e.hit) selfHarm = e.seat; break;
      case 'summon': cardOf.set(e.uid, e.cardId); break;
      case 'play':
        sides[e.seat].cardsPlayed++;
        cardOf.set(e.uid, e.cardId);
        source = { seat: e.seat, cardId: e.cardId };
        break;
      case 'attack': {
        const id = cardOf.get(e.attacker);
        source = id !== undefined ? { seat: e.seat, cardId: id } : null;
        break;
      }
      case 'turnStart': source = null; break;
      case 'damage': {
        if (selfHarm === e.seat && e.uid === 'treasury') { selfHarm = null; break; }
        const by = (1 - e.seat) as 0 | 1;
        const s = sides[by];
        s.damage += e.n;
        if (e.uid === 'treasury') s.treasuryDamage += e.n;
        s.biggestHit = Math.max(s.biggestHit, e.n);
        if (source && source.seat === by) tally[by].set(source.cardId, (tally[by].get(source.cardId) ?? 0) + e.n);
        break;
      }
      case 'death': sides[(1 - e.seat) as 0 | 1].kills++; break;
      default: break;
    }
  }
  const mvp = tally.map((t) => {
    let best: Mvp | null = null;
    for (const [cardId, damage] of t) if (!best || damage > best.damage) best = { cardId, damage };
    return best;
  }) as [Mvp | null, Mvp | null];
  return { sides, mvp };
}

/** Counts from `from` to `to` over `ms` with an ease-out; jumps straight there with reduced motion. */
export function useCountUp(to: number, ms = 900, from = 0, delay = 0): number {
  const [v, setV] = useState(from);
  useEffect(() => {
    const reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { setV(to); return; }
    let raf = 0;
    const start = performance.now() + delay;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / ms));
      setV(Math.round(from + (to - from) * (1 - (1 - t) ** 3)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, ms, from, delay]);
  return v;
}
