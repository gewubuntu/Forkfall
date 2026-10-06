import { questDay } from './quests.ts';

/**
 * The season pass: one XP bar per four-week season, 30 tiers, a free track for everyone and a premium track for
 * holders of that season's pass. Shared by the referee (which counts XP from the matches it refereed and pays tier
 * rewards through QuestRewards) and the web app (which shows the bar and the tracks). Rewards are game items only:
 * Scrap, Set 1 packs and season cosmetics. XP from matches is capped per day, so grinding never outruns the bar.
 */

export const PASS_TIERS = 30;
export const PASS_XP_PER_TIER = 300;
export const PASS_SEASON_DAYS = 28;
/** Season 1 starts on Monday 5 Oct 2026, 00:00 UTC (UTC day 20731); every season after it starts on a Monday. */
export const PASS_EPOCH_DAY = 20731;

export const XP_MATCH_PLAYED = 20;
export const XP_MATCH_WON = 15;
export const XP_QUEST = 80;
export const XP_FIRST_WIN = 40;
/** Match XP (played + won) per player per UTC day; quests and the first win come on top. */
export const XP_MATCH_DAILY_CAP = 300;
/**
 * Matches against a house bot count, but for less, so the pass can't be farmed against bots: 10 XP (+5 for a win), at
 * most 100 a day (inside the match cap), and a quest or first win finished in a bot match gives half its XP. Playing
 * only bots gets about 240 XP a day at most, short of finishing the pass in a season; real opponents finish it.
 */
export const XP_BOT_MATCH_PLAYED = 10;
export const XP_BOT_MATCH_WON = 5;
export const XP_BOT_DAILY_CAP = 100;
export const XP_BOT_SHARE = 0.5;

export type PassTrack = 'free' | 'premium';
export type PassCosmetic = 'title' | 'cardBack' | 'badge';
export interface PassReward { scrap?: number; packs?: number; cosmetic?: PassCosmetic }
export interface PassTier { tier: number; free?: PassReward; premium?: PassReward }

const FREE_PACK_TIERS = new Set([10, 20, 30]);
const PREMIUM_PACK_TIERS = new Set([4, 8, 12, 16, 20, 24, 28, 30]);

/** Every tier's rewards, tier 1 to 30. */
export const PASS_TIERS_TABLE: PassTier[] = Array.from({ length: PASS_TIERS }, (_, i): PassTier => {
  const tier = i + 1;
  const t: PassTier = { tier };
  if (FREE_PACK_TIERS.has(tier)) t.free = { packs: 1, ...(tier === PASS_TIERS ? { cosmetic: 'title' } : {}) };
  else if (tier % 2 === 0) t.free = { scrap: 50 };
  if (tier === 1) t.premium = { cosmetic: 'cardBack' };
  else if (PREMIUM_PACK_TIERS.has(tier)) t.premium = { packs: 1, ...(tier === PASS_TIERS ? { cosmetic: 'badge' } : {}) };
  else t.premium = { scrap: 50 };
  return t;
});

/** What a whole track pays over a season. */
export function trackTotals(track: PassTrack): { scrap: number; packs: number; cosmetics: PassCosmetic[] } {
  const out = { scrap: 0, packs: 0, cosmetics: [] as PassCosmetic[] };
  for (const t of PASS_TIERS_TABLE) {
    const r = t[track];
    if (!r) continue;
    out.scrap += r.scrap ?? 0;
    out.packs += r.packs ?? 0;
    if (r.cosmetic) out.cosmetics.push(r.cosmetic);
  }
  return out;
}

/** The season a UTC day falls in (season 1 from the epoch; days before it count as season 1), and its days. */
export function passSeason(day: number) {
  const season = Math.max(1, Math.floor((day - PASS_EPOCH_DAY) / PASS_SEASON_DAYS) + 1);
  const first = PASS_EPOCH_DAY + (season - 1) * PASS_SEASON_DAYS;
  return { season, first, last: first + PASS_SEASON_DAYS - 1 };
}
export const passSeasonAt = (ms: number) => passSeason(questDay(ms));

/** Tiers reached with this much XP (0 to 30). */
export const tierFor = (xp: number) => Math.min(PASS_TIERS, Math.floor(Math.max(0, xp) / PASS_XP_PER_TIER));

/** XP one finished match earns before the daily caps. A win against the easy `random` bot isn't a win. */
export const matchXp = (won: boolean, vsBot = false) =>
  vsBot ? XP_BOT_MATCH_PLAYED + (won ? XP_BOT_MATCH_WON : 0) : XP_MATCH_PLAYED + (won ? XP_MATCH_WON : 0);

/** Quest or first-win XP, halved when the match that finished it was against a house bot. */
export const bonusXp = (xp: number, vsBot = false) => (vsBot ? Math.floor(xp * XP_BOT_SHARE) : xp);

/** Cosmetic ids a season's pass unlocks: the title (free, tier 30), card back (premium, tier 1), badge (premium, tier 30). */
export const passCosmeticId = (kind: PassCosmetic, season: number) => `${kind === 'cardBack' ? 'back' : kind}:season-${season}`;

/** The season and kind of a season cosmetic id, or null for any other id. */
export function parsePassCosmetic(id: string): { kind: PassCosmetic; season: number } | null {
  const m = /^(title|back|badge):season-(\d+)$/.exec(id);
  if (!m) return null;
  return { kind: m[1] === 'back' ? 'cardBack' : (m[1] as PassCosmetic), season: Number(m[2]) };
}

/** Which track and tier unlock a season cosmetic. */
export function passCosmeticTier(kind: PassCosmetic): { track: PassTrack; tier: number } {
  for (const t of PASS_TIERS_TABLE) {
    if (t.free?.cosmetic === kind) return { track: 'free', tier: t.tier };
    if (t.premium?.cosmetic === kind) return { track: 'premium', tier: t.tier };
  }
  throw new Error(`no tier unlocks ${kind}`);
}

export const passCosmeticName = (kind: PassCosmetic, season: number) =>
  kind === 'title' ? `Season ${season} Veteran` : kind === 'cardBack' ? `Season ${season} card back` : `Season ${season} badge`;
