import { describe, expect, it } from 'vitest';
import { paidCount, planPayouts } from '../src/league.ts';

describe('league payout count', () => {
  it('pays the top half rounded up, and nobody below two eligible agents', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(paidCount)).toEqual([0, 0, 1, 2, 2, 3, 5]);
  });
});

describe('league payout plan', () => {
  const agents = (n: number) => Array.from({ length: n }, (_, i) => ({ agent: `a${i}`, games: 10, opponents: 5 }));

  it('pays nothing and keeps the pot for a lone eligible agent', () => {
    const plan = planPayouts(agents(1), 1_000_000n);
    expect(plan.paid).toEqual([]);
    expect(plan.unpaid.map((u) => u.reason)).toEqual(['too-few-eligible']);
  });

  it('pays two of three, linear by rank, and the amounts add up to the pot', () => {
    const plan = planPayouts(agents(3), 1_000_001n);
    expect(plan.paid.map((p) => p.agent.agent)).toEqual(['a0', 'a1']);
    expect(plan.paid.reduce((t, p) => t + p.amount, 0n)).toBe(1_000_001n);
    expect(plan.paid[0].amount).toBeGreaterThan(plan.paid[1].amount);
    expect(plan.unpaid).toEqual([{ agent: agents(3)[2], reason: 'below-cut' }]);
  });
});
