import {
  dailyQuests, dayStartMs, FIRST_WIN_SCRAP, matchCounts, PACK_GOAL, PACK_PERIOD_DAYS, packPeriod, questDay, REROLLS_PER_DAY,
  type GameEvent, type Race,
} from '@forkfall/engine';
import type { QuestStatus } from '@forkfall/sdk';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import type { QuestRewarder } from './chain.ts';
import type { Match } from './lobby.ts';

/** Where quest progress and payouts are kept: apps/server/data/quests/<chainId>.json. */
export const questsFile = (root: string, chainId: number) => join(root, 'apps/server/data/quests', `${chainId}.json`);

/** A finished match, as quests see it. */
export interface FinishedMatch {
  id: string;
  endedAt: number;
  turns: number;
  winner: 0 | 1 | 'draw' | null;
  /** `bot`: the house bot's kind, if this seat is one. Wins against the easy `random` bot don't count. */
  players: { address: string; race: Race; bot: string | null }[];
  events: GameEvent[];
}

/** A finished lobby match in the shape quests count (null while it isn't finished). */
export function finishedMatch(m: Match): FinishedMatch | null {
  if (m.phase !== 'ended' || !m.state || m.endedAt === undefined) return null;
  return {
    id: m.id, endedAt: m.endedAt, turns: m.state.turn, winner: m.state.winner, events: m.events,
    players: m.players.map((p) => ({ address: p.address, race: p.race, bot: p.bot ?? null })),
  };
}

interface DayState { day: number; rerolls: number[]; rerollsUsed: number; progress: number[]; firstWin: boolean }
interface PlayerState { today: DayState; /** Daily quests completed per pack period index. */ periods: Record<string, number> }

export interface Payout {
  claimId: Hex;
  address: string;
  kind: 'quest' | 'firstWin' | 'pack';
  /** Quest id, 'first-win', or 'pack-<period>'. */
  ref: string;
  day: number;
  scrap: number;
  packKind: number;
  packs: number;
  /** offchain: this server can't pay (no QuestRewards); the reward is recorded but never sent.
   *  failed: the contract refused it for good (caps, unknown pack kind, missing role) or it kept failing. */
  state: 'pending' | 'paid' | 'offchain' | 'failed';
  tx?: Hex;
  error?: string;
  attempts: number;
  nextAt: number;
}

interface Store { players: Record<string, PlayerState>; payouts: Payout[]; seen: string[] }

export interface QuestOptions {
  file?: string;
  rewarder?: QuestRewarder | null;
  chainId: number;
  /** Days per free-pack period (7 = weekly, 14 = every two weeks). */
  periodDays?: number;
  /** Daily quests to complete within a period for its free pack (default 10 per week, scaled with the period). */
  packGoal?: number;
  /** Booster kind of the free pack (0 = Set 1). */
  packKind?: number;
  now?: () => number;
}

const SEEN_LIMIT = 5000;
const RETRY_MAX_MS = 60 * 60_000;
const MAX_ATTEMPTS = 20;
/** A match that ends this soon after midnight UTC may still count for the day before (slow final moves). */
const MIDNIGHT_GRACE_MS = 10 * 60_000;
/** Reverts that will never succeed on retry. */
const PERMANENT = /OverClaimCap|NothingToPay|UnknownKind|BadCount|AccessControlUnauthorizedAccount/;
/** Paid and off-chain payouts are kept this long for the status view, then pruned. */
const KEEP_DAYS = 40;

/**
 * Daily quests, the first-win bonus and the free pack, tracked by the referee from finished matches (it replays
 * every signed move, so progress can't be faked) and paid on-chain through QuestRewards. Payouts are queued and
 * retried until they land; each has a unique claim id, so the contract never pays one twice.
 */
export class Quests {
  private data: Store;
  private busy = false;
  readonly periodDays: number;
  readonly packGoal: number;
  readonly packKind: number;
  private now: () => number;

  constructor(private opts: QuestOptions) {
    this.data = opts.file && existsSync(opts.file) ? JSON.parse(readFileSync(opts.file, 'utf8')) : { players: {}, payouts: [], seen: [] };
    this.periodDays = opts.periodDays ?? PACK_PERIOD_DAYS;
    this.packGoal = opts.packGoal ?? Math.round((PACK_GOAL * this.periodDays) / PACK_PERIOD_DAYS);
    this.packKind = opts.packKind ?? 0;
    this.now = opts.now ?? Date.now;
    if (!Number.isInteger(this.periodDays) || this.periodDays < 1) throw new Error(`quest pack period must be a whole number of days, got ${opts.periodDays}`);
    if (!Number.isInteger(this.packGoal) || this.packGoal < 1) throw new Error(`quest pack goal must be at least 1, got ${opts.packGoal}`);
    if (!Number.isInteger(this.packKind) || this.packKind < 0 || this.packKind > 255) throw new Error(`quest pack kind must be 0-255, got ${opts.packKind}`);
  }

  get paysOnChain() { return !!this.opts.rewarder; }

  /** Counts a finished match for both players (house bots excluded). Idempotent per match id. */
  record(m: FinishedMatch): Payout[] {
    if (this.data.seen.includes(m.id) || !matchCounts(m)) return [];
    // Only matches that just ended count: never old ones replayed later (restored archives, re-signed results).
    const day = questDay(m.endedAt);
    const now = this.now();
    if (day !== questDay(now) && !(day === questDay(now) - 1 && now - dayStartMs(questDay(now)) < MIDNIGHT_GRACE_MS)) return [];
    if (m.endedAt > now + 60_000) return [];
    this.data.seen.push(m.id);
    if (this.data.seen.length > SEEN_LIMIT) this.data.seen.splice(0, this.data.seen.length - SEEN_LIMIT);
    const out: Payout[] = [];
    m.players.forEach((pl, seat) => {
      if (pl.bot) return;
      const address = pl.address.toLowerCase();
      // Beating the easy random house bot isn't a win for quests (it still counts as a match played).
      const softOpponent = m.players[1 - seat]?.bot === 'random';
      const p = this.player(address, day);
      if (p.today.day !== day) return; // a match that ended before today's reset counts for nothing
      const won = m.winner === seat && !softOpponent;
      const qs = dailyQuests(address, day, p.today.rerolls);
      const period = packPeriod(day, this.periodDays).index;
      qs.forEach((q, slot) => {
        if (p.today.progress[slot] >= q.goal) return;
        p.today.progress[slot] = Math.min(q.goal, p.today.progress[slot] + q.progress({ seat: seat as 0 | 1, won, race: pl.race, turns: m.turns, events: m.events }));
        if (p.today.progress[slot] < q.goal) return;
        out.push(this.queue(address, 'quest', `${q.id}#${slot}`, day, q.scrap, 0));
        p.periods[period] = (p.periods[period] ?? 0) + 1;
        if (p.periods[period] === this.packGoal) out.push(this.queue(address, 'pack', `pack-${period}`, day, 0, 1));
      });
      if (won && !p.today.firstWin) {
        p.today.firstWin = true;
        out.push(this.queue(address, 'firstWin', 'first-win', day, FIRST_WIN_SCRAP, 0));
      }
    });
    this.save();
    return out;
  }

  /** Swaps one of today's quests (not yet completed) for another from its group. One reroll a day. */
  reroll(address: Address, slot: number): QuestStatus {
    const a = address.toLowerCase();
    const day = questDay(this.now());
    const p = this.player(a, day);
    if (!Number.isInteger(slot) || slot < 0 || slot >= p.today.progress.length) throw new Error('unknown quest slot');
    if (p.today.rerollsUsed >= REROLLS_PER_DAY) throw new Error('no rerolls left today');
    const q = dailyQuests(a, day, p.today.rerolls)[slot];
    if (p.today.progress[slot] >= q.goal) throw new Error('that quest is already complete');
    p.today.rerolls[slot] = (p.today.rerolls[slot] ?? 0) + 1;
    p.today.rerollsUsed++;
    p.today.progress[slot] = 0;
    this.save();
    return this.status(address);
  }

  status(address: string): QuestStatus {
    const a = address.toLowerCase();
    const day = questDay(this.now());
    const stored = this.data.players[a];
    const today: DayState = stored?.today.day === day ? stored.today : fresh(day);
    const payout = (ref: string, d = day) => {
      const x = this.data.payouts.find((y) => y.address === a && y.ref === ref && y.day === d);
      return x ? { state: x.state, tx: x.tx, error: x.error } : undefined;
    };
    const period = packPeriod(day, this.periodDays);
    const packPayout = this.data.payouts.find((y) => y.address === a && y.ref === `pack-${period.index}`);
    return {
      day,
      resetsAt: dayStartMs(day + 1),
      paysOnChain: this.paysOnChain,
      rerollsLeft: REROLLS_PER_DAY - today.rerollsUsed,
      quests: dailyQuests(a, day, today.rerolls).map((q, slot) => ({
        slot, id: q.id, group: q.group, text: q.text, goal: q.goal, scrap: q.scrap,
        progress: today.progress[slot] ?? 0, done: (today.progress[slot] ?? 0) >= q.goal, payout: payout(`${q.id}#${slot}`),
      })),
      firstWin: { done: today.firstWin, scrap: FIRST_WIN_SCRAP, payout: payout('first-win') },
      pack: {
        goal: this.packGoal, completed: stored?.periods[period.index] ?? 0, kind: this.packKind, periodDays: this.periodDays,
        startsAt: dayStartMs(period.first), endsAt: dayStartMs(period.last + 1),
        payout: packPayout ? { state: packPayout.state, tx: packPayout.tx, error: packPayout.error } : undefined,
      },
    };
  }

  /** Sends due payouts, one at a time. Failed ones retry with backoff; "already claimed" means it landed before. */
  async payDue(): Promise<{ paid: Payout[]; failed: Payout[] }> {
    const paid: Payout[] = []; const failed: Payout[] = [];
    const r = this.opts.rewarder;
    if (!r || this.busy) return { paid, failed };
    this.busy = true;
    try {
      for (const p of this.data.payouts.filter((x) => x.state === 'pending' && x.nextAt <= this.now())) {
        try {
          p.tx = await r.reward(p.address as Address, p.claimId, p.scrap, p.packKind, p.packs);
          p.state = 'paid'; p.error = undefined; paid.push(p);
        } catch (e) {
          const msg = (e as Error).message;
          if (/AlreadyClaimed/.test(msg)) { p.state = 'paid'; p.error = undefined; paid.push(p); }
          else {
            p.attempts++; p.error = msg;
            p.nextAt = this.now() + Math.min(RETRY_MAX_MS, 30_000 * 2 ** p.attempts);
            if (PERMANENT.test(msg) || p.attempts >= MAX_ATTEMPTS) p.state = 'failed';
            failed.push(p);
          }
        }
        this.save();
      }
    } finally { this.busy = false; }
    return { paid, failed };
  }

  private player(address: string, day: number): PlayerState {
    const p = (this.data.players[address] ??= { today: fresh(day), periods: {} });
    if (p.today.day < day) p.today = fresh(day);
    return p;
  }

  private queue(address: string, kind: Payout['kind'], ref: string, day: number, scrap: number, packs: number): Payout {
    const claimId = keccak256(toHex(`forkfall-quest:${this.opts.chainId}:${address}:${day}:${ref}`));
    const p: Payout = {
      claimId, address, kind, ref, day, scrap, packKind: packs ? this.packKind : 0, packs,
      state: this.paysOnChain ? 'pending' : 'offchain', attempts: 0, nextAt: 0,
    };
    this.data.payouts.push(p);
    return p;
  }

  private save() {
    this.prune();
    if (!this.opts.file) return;
    mkdirSync(dirname(this.opts.file), { recursive: true });
    // Write then rename, so a crash mid-write never leaves a half-written file behind.
    const tmp = `${this.opts.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.opts.file);
  }

  /** Drops settled payouts and pack-period counts nobody can see any more. */
  private prune() {
    const today = questDay(this.now());
    const minDay = today - KEEP_DAYS;
    if (this.data.payouts.some((p) => p.day < minDay && p.state !== 'pending')) {
      this.data.payouts = this.data.payouts.filter((p) => p.day >= minDay || p.state === 'pending');
    }
    const current = packPeriod(today, this.periodDays).index;
    for (const p of Object.values(this.data.players)) {
      for (const k of Object.keys(p.periods)) if (Number(k) < current - 1) delete p.periods[k];
    }
  }
}

function fresh(day: number): DayState {
  return { day, rerolls: [0, 0, 0], rerollsUsed: 0, progress: [0, 0, 0], firstWin: false };
}
