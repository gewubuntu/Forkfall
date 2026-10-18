import { describe, expect, it } from 'vitest';
import { paidCount } from '../src/league.ts';

describe('league payout count', () => {
  it('pays the top half rounded up, and nobody below two eligible agents', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(paidCount)).toEqual([0, 0, 1, 2, 2, 3, 5]);
  });
});
