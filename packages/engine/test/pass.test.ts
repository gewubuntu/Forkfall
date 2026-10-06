import { describe, expect, it } from 'vitest';
import {
  cosmetic, matchXp, milestoneMet, parsePassCosmetic, PASS_EPOCH_DAY, PASS_SEASON_DAYS, PASS_TIERS, PASS_TIERS_TABLE, PASS_XP_PER_TIER,
  passCosmeticId, passSeason, tierFor, trackTotals, XP_FIRST_WIN, XP_MATCH_DAILY_CAP, XP_QUEST,
} from '../src/index.ts';

describe('season pass', () => {
  it('pays what the GDD promises on each track', () => {
    expect(trackTotals('free')).toEqual({ scrap: 600, packs: 3, cosmetics: ['title'] });
    expect(trackTotals('premium')).toEqual({ scrap: 1050, packs: 8, cosmetics: ['cardBack', 'badge'] });
    expect(PASS_TIERS_TABLE).toHaveLength(PASS_TIERS);
    expect(PASS_TIERS_TABLE.every((t) => t.premium)).toBe(true); // something on every premium tier
  });

  it('keeps every tier reward within one QuestRewards claim (500 Scrap, 2 packs)', () => {
    for (const t of PASS_TIERS_TABLE) for (const r of [t.free, t.premium]) {
      expect(r?.scrap ?? 0).toBeLessThanOrEqual(500);
      expect(r?.packs ?? 0).toBeLessThanOrEqual(2);
    }
  });

  it('runs four-week seasons from a Monday', () => {
    expect(new Date(PASS_EPOCH_DAY * 86_400_000).getUTCDay()).toBe(1);
    expect(passSeason(PASS_EPOCH_DAY)).toEqual({ season: 1, first: PASS_EPOCH_DAY, last: PASS_EPOCH_DAY + 27 });
    expect(passSeason(PASS_EPOCH_DAY + PASS_SEASON_DAYS - 1).season).toBe(1);
    expect(passSeason(PASS_EPOCH_DAY + PASS_SEASON_DAYS).season).toBe(2);
    expect(passSeason(PASS_EPOCH_DAY - 3).season).toBe(1); // before launch: season 1
  });

  it('turns XP into tiers, capped at the last one', () => {
    expect(tierFor(0)).toBe(0);
    expect(tierFor(PASS_XP_PER_TIER - 1)).toBe(0);
    expect(tierFor(PASS_XP_PER_TIER)).toBe(1);
    expect(tierFor(10 ** 9)).toBe(PASS_TIERS);
    expect(matchXp(false)).toBe(20);
    expect(matchXp(true)).toBe(35);
  });

  it('paces the pass as designed: about 24 moderate days or 16 full days', () => {
    const moderate = 3 * matchXp(false) + 1.5 * (matchXp(true) - matchXp(false)) + 3 * XP_QUEST + XP_FIRST_WIN;
    const full = XP_MATCH_DAILY_CAP + 3 * XP_QUEST + XP_FIRST_WIN;
    const total = PASS_TIERS * PASS_XP_PER_TIER;
    expect(Math.round(total / moderate)).toBe(25);
    expect(Math.ceil(total / full)).toBe(16);
    expect(total / moderate).toBeLessThan(PASS_SEASON_DAYS); // a moderate player can finish within the season
  });

  it('names season cosmetics and never unlocks them by a collection milestone', () => {
    expect(passCosmeticId('cardBack', 3)).toBe('back:season-3');
    expect(parsePassCosmetic('badge:season-12')).toEqual({ kind: 'badge', season: 12 });
    expect(parsePassCosmetic('title:agents')).toBeNull();
    expect(cosmetic('title:season-2')).toMatchObject({ kind: 'title', name: 'Season 2 Veteran', rule: 'pass', season: 2 });
    expect(cosmetic('back:season-1')?.description).toMatch(/tier 1 of the season 1 pass with the premium track/);
    expect(cosmetic('badge:season-0')).toBeUndefined();
    expect(milestoneMet('pass', undefined, () => 99, ['basics'])).toBe(false);
  });
});
