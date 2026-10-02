import { card, TOKEN_BOND, TOKEN_DRONE } from './cards.ts';
import { keccakHex } from './rng.ts';
import type { GameEvent, Race, Seat } from './types.ts';

/**
 * Daily quests: three a day per player (one per group), counted by the referee from finished matches. Shared
 * by the server (progress and payouts) and the web app (text and progress bars). Rewards are Scrap; completing
 * enough quests in a pack period (weekly by default) also earns a free pack, and the first win each day pays a
 * bonus. Every reward is bounded per day, so playing more never farms more than the day's quests.
 */

/** What a quest sees of one finished match, from one player's side. */
export interface QuestMatch {
  seat: Seat;
  won: boolean;
  race: Race;
  /** Turns the match lasted; matches shorter than `QUEST_MIN_TURNS` don't count (no instant-concede farming). */
  turns: number;
  events: GameEvent[];
}

export type QuestGroup = 'win' | 'play' | 'race';

export interface QuestDef {
  id: string;
  group: QuestGroup;
  text: string;
  goal: number;
  /** Scrap paid on completion. */
  scrap: number;
  /** Progress this match adds. */
  progress: (m: QuestMatch) => number;
}

export const QUEST_MIN_TURNS = 4;
export const QUESTS_PER_DAY = 3;
export const REROLLS_PER_DAY = 1;
export const FIRST_WIN_SCRAP = 50;
/** Free pack: complete this many daily quests within one pack period (default a week, starting Monday 00:00 UTC). */
export const PACK_GOAL = 10;
export const PACK_PERIOD_DAYS = 7;

const DAY_MS = 86_400_000;
/** Day 4 since the epoch (1970-01-05) was a Monday: pack periods start on Mondays. */
const MONDAY = 4;

const mine = (m: QuestMatch, t: GameEvent['t']) => m.events.filter((e) => e.t === t && 'seat' in e && e.seat === m.seat);
const theirs = (m: QuestMatch, t: GameEvent['t']) => m.events.filter((e) => e.t === t && 'seat' in e && e.seat !== m.seat);
const plays = (m: QuestMatch) => mine(m, 'play') as Extract<GameEvent, { t: 'play' }>[];
const RACE_LABEL: Record<Race, string> = { agents: 'Agents', prophets: 'Prophets', brokers: 'Brokers', degens: 'Degens' };

export const QUESTS: QuestDef[] = [
  { id: 'win2', group: 'win', text: 'Win 2 matches', goal: 2, scrap: 40, progress: (m) => (m.won ? 1 : 0) },
  ...(['agents', 'prophets', 'brokers', 'degens'] as Race[]).map((r): QuestDef => ({
    id: `win-${r}`, group: 'win', text: `Win a match as the ${RACE_LABEL[r]}`, goal: 1, scrap: 40, progress: (m) => (m.won && m.race === r ? 1 : 0),
  })),
  { id: 'play3', group: 'play', text: 'Play 3 matches', goal: 3, scrap: 30, progress: () => 1 },
  { id: 'units10', group: 'play', text: 'Play 10 units', goal: 10, scrap: 25, progress: (m) => plays(m).filter((e) => card(e.cardId).type === 'unit').length },
  { id: 'actions6', group: 'play', text: 'Play 6 action cards', goal: 6, scrap: 25, progress: (m) => plays(m).filter((e) => card(e.cardId).type === 'action').length },
  { id: 'rush5', group: 'play', text: 'Play 5 units with Rush', goal: 5, scrap: 25, progress: (m) => plays(m).filter((e) => card(e.cardId).keywords.includes('rush')).length },
  {
    id: 'damage20', group: 'play', text: 'Deal 20 damage to enemy Treasuries', goal: 20, scrap: 30,
    progress: (m) => (theirs(m, 'damage') as Extract<GameEvent, { t: 'damage' }>[]).filter((e) => e.uid === 'treasury').reduce((a, e) => a + e.n, 0),
  },
  { id: 'defeat8', group: 'play', text: 'Defeat 8 enemy units', goal: 8, scrap: 30, progress: (m) => theirs(m, 'death').length },
  {
    id: 'predict2', group: 'race', text: 'Make 2 correct predictions (Prophets)', goal: 2, scrap: 35,
    progress: (m) => (mine(m, 'predictionResolved') as Extract<GameEvent, { t: 'predictionResolved' }>[]).filter((e) => e.hit).length,
  },
  { id: 'hold4', group: 'race', text: 'Grow units with Hold 4 times (Brokers)', goal: 4, scrap: 30, progress: (m) => mine(m, 'hold').length },
  {
    id: 'deploy6', group: 'race', text: 'Summon 6 Drones or Bonds (Agents, Brokers)', goal: 6, scrap: 30,
    progress: (m) => (mine(m, 'summon') as Extract<GameEvent, { t: 'summon' }>[]).filter((e) => e.cardId === TOKEN_DRONE || e.cardId === TOKEN_BOND).length,
  },
  { id: 'ape3', group: 'race', text: 'Ape 3 cards (Degens)', goal: 3, scrap: 30, progress: (m) => plays(m).filter((e) => e.ape).length },
];

export const quest = (id: string): QuestDef | undefined => QUESTS.find((q) => q.id === id);
const GROUPS: QuestGroup[] = ['win', 'play', 'race'];

/** UTC day number of a timestamp (ms). Quests reset at 00:00 UTC. */
export const questDay = (ms: number) => Math.floor(ms / DAY_MS);
export const dayStartMs = (day: number) => day * DAY_MS;

/** The pack period a day falls in, and its first and last day (inclusive). */
export function packPeriod(day: number, periodDays = PACK_PERIOD_DAYS) {
  const index = Math.floor((day - MONDAY) / periodDays);
  const first = index * periodDays + MONDAY;
  return { index, first, last: first + periodDays - 1 };
}

/**
 * A player's quests for a day: one per group, picked from a hash of address and day (the same everywhere).
 * `rerolls[slot]` is how many times that slot was rerolled; each reroll moves to the next quest in its group.
 */
export function dailyQuests(address: string, day: number, rerolls: number[] = []): QuestDef[] {
  const h = keccakHex('forkfall-quests', address.toLowerCase(), String(day));
  return GROUPS.map((g, slot) => {
    const pool = QUESTS.filter((q) => q.group === g);
    const base = parseInt(h.slice(2 + slot * 8, 10 + slot * 8), 16);
    return pool[(base + (rerolls[slot] ?? 0)) % pool.length];
  });
}

/** Whether a finished match counts toward quests at all. */
export const matchCounts = (m: Pick<QuestMatch, 'turns'>) => m.turns >= QUEST_MIN_TURNS;
