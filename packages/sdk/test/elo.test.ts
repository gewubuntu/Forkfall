import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ELO_TABLE, eloUpdate, expectedScore, K_FACTOR, MIN_RATING, START_RATING } from '../src/index.ts';

const contract = (name: string) => readFileSync(resolve(import.meta.dirname, `../../../contracts/src/${name}.sol`), 'utf8');
const constant = (src: string, name: string) => Number(new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(src)![1]);

describe('Elo mirror of the contracts', () => {
  it('uses MatchSettlement\'s table, start rating and K factor, and AgentLeague\'s', () => {
    const src = contract('MatchSettlement');
    const table = /ELO\s*=\s*\[([^\]]+)\]/.exec(src)![1].split(',').map((s) => Number(s.trim()));
    expect(ELO_TABLE).toEqual(table);
    for (const c of [src, contract('AgentLeague')]) {
      expect(constant(c, 'START_RATING')).toBe(START_RATING);
      expect(constant(c, 'K_FACTOR')).toBe(K_FACTOR);
    }
    expect(src).toContain(`r < ${MIN_RATING} ? int256(${MIN_RATING})`);
  });

  it('expected score is symmetric and steps every 25 points', () => {
    expect(expectedScore(1200, 1200)).toBe(500);
    expect(expectedScore(1224, 1200)).toBe(500);
    expect(expectedScore(1225, 1200)).toBe(536);
    expect(expectedScore(1200, 1225)).toBe(464);
    expect(expectedScore(3000, 100)).toBe(990);
  });

  it('updates like the contract: rounds toward zero and floors at 100', () => {
    expect(eloUpdate(1200, 1200, 1000)).toEqual([1216, 1184]);
    expect(eloUpdate(1200, 1200, 500)).toEqual([1200, 1200]);
    // Favourite wins: 32 * (1000 - 640) / 1000 = 11.52 → 11.
    expect(eloUpdate(1300, 1200, 1000)).toEqual([1311, 1189]);
    // Favourite loses: 32 * (0 - 640) / 1000 = -20.48 → -20 (toward zero, not -21).
    expect(eloUpdate(1300, 1200, 0)).toEqual([1280, 1220]);
    expect(eloUpdate(110, 110, 0)).toEqual([MIN_RATING, 126]); // 110 - 16 = 94, floored
  });
});
