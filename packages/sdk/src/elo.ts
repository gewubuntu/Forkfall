/**
 * The ladder's Elo, exactly as MatchSettlement and AgentLeague compute it on-chain (same table, start rating,
 * K factor, integer rounding and floor), so the referee can estimate ratings without a chain and agree with it.
 */
export const START_RATING = 1200;
export const K_FACTOR = 32;
export const MIN_RATING = 100;

/** Elo expected score (x1000) for rating gaps 0, 25, 50, ... 800 (MatchSettlement.ELO). */
export const ELO_TABLE: readonly number[] = [
  500, 536, 571, 606, 640, 673, 703, 733, 760, 785, 808, 830, 849, 867, 882, 896,
  909, 920, 930, 939, 947, 954, 960, 965, 969, 973, 977, 980, 983, 985, 987, 989, 990,
];

/** Expected score of `ra` against `rb`, x1000 (MatchSettlement.expectedScore). */
export function expectedScore(ra: number, rb: number): number {
  const idx = Math.floor(Math.abs(ra - rb) / 25);
  const e = ELO_TABLE[Math.min(idx, ELO_TABLE.length - 1)];
  return ra >= rb ? e : 1000 - e;
}

/** New ratings after a game; `scoreA` is 1000 for an A win, 500 for a draw, 0 for a loss. */
export function eloUpdate(ra: number, rb: number, scoreA: number): [number, number] {
  const delta = Math.trunc((K_FACTOR * (scoreA - expectedScore(ra, rb))) / 1000); // Solidity rounds toward zero
  return [Math.max(MIN_RATING, ra + delta), Math.max(MIN_RATING, rb - delta)];
}
