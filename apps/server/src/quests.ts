import {
  dailyQuests, dayStartMs, FIRST_WIN_SCRAP, bonusXp, matchCounts, matchXp, PACK_GOAL, PACK_PERIOD_DAYS, packPeriod, PASS_TIERS_TABLE, PASS_XP_PER_TIER,
  passCosmeticId, passSeason, questDay, REROLLS_PER_DAY, tierFor, XP_BOT_DAILY_CAP, XP_FIRST_WIN, XP_MATCH_DAILY_CAP, XP_QUEST,
  type GameEvent, type PassTrack, type Race,
} from '@forkfall/engine';
import type { PassStatus, QuestStatus } from '@forkfall/sdk';
import { join } from 'node:path';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import type { QuestRewarder } from './chain.ts';
import type { Match } from './lobby.ts';
import { readJsonOrSetAside, writeFileAtomic } from './state.ts';

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
  /** Whether each seat is a registered or declared agent (metrics tell agents from humans). */
  agents?: boolean[];
  /** 'sealed' for a Sealed match (a house-bot seat there is not Practice). */
  format?: 'sealed';
  events: GameEvent[];
  /** The friend challenge this match was played for, if any (its gift is delivered after it). */
  challenge?: string;
}

/** A finished lobby match in the shape quests count (null while it isn't finished). */
export function finishedMatch(m: Match): FinishedMatch | null {
  if (m.phase !== 'ended' || !m.state || m.endedAt === undefined) return null;
  return {
    id: m.id, endedAt: m.endedAt, turns: m.state.turn, winner: m.state.winner, events: m.events,
    players: m.players.map((p) => ({ address: p.address, race: p.race, bot: p.bot ?? null })),
    agents: m.players.map((p) => !!p.agent),
    ...(m.format ? { format: m.format } : {}),
    ...(m.challenge ? { challenge: m.challenge } : {}),
  };
}

interface DayState { day: number; rerolls: number[]; rerollsUsed: number; progress: number[]; firstWin: boolean }
/** Season pass progress for the current season (reset when a new season starts). */
interface PassState {
  season: number;
  xp: number;
  /** Match XP earned on `matchDay` (capped per day). */
  matchDay: number;
  matchXp: number;
  /** The part of `matchXp` earned against house bots (capped lower). */
  botXp?: number;
  /** Highest tier whose rewards were queued, per track. */
  freeTier: number;
  premiumTier: number;
  /** This season's premium pass, as last read from SeasonPass (true is final for the season). */
  premium?: boolean;
  premiumCheckedAt?: number;
}
/** A past season whose premium pass is still to be read once (bought near the end, before the last check saw it). */
type ClosingPass = PassState & { nextAt?: number };
interface PlayerState {
  today: DayState;
  /** Daily quests completed per pack period index. */
  periods: Record<string, number>;
  pass?: PassState;
  /** Past seasons with tiers reached but no premium seen yet: read once more after the season ends. */
  closing?: ClosingPass[];
  /** Season cosmetics earned, kept across seasons. */
  unlocked?: string[];
}

export interface Payout {
  claimId: Hex;
  address: string;
  kind: 'quest' | 'firstWin' | 'pack' | 'pass' | 'referral' | 'sealed';
  /** Quest id, 'first-win', 'pack-<period>', 'pass-s<season>-<track>-<tier>', or 'referral-<invited>'. */
  ref: string;
  day: number;
  scrap: number;
  packKind: number;
  packs: number;
  /** offchain: this server can't pay (no QuestRewards); the reward is recorded but never sent.
   *  failed: the contract refused it for good (caps, unknown pack kind, missing role) or it kept failing.
   *  held: earned, but the player isn't a verified human or registered agent yet; paid once they are
   *  (re-checked every few minutes), dropped after `KEEP_DAYS`. */
  state: 'pending' | 'paid' | 'offchain' | 'failed' | 'held';
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
  /** Who may be paid: verified humans and registered agents (not banned), like season rewards. Progress is
   *  tracked for everyone; rewards for others are held until they qualify. Omit to pay everyone. */
  eligible?: (address: Address) => Promise<boolean>;
  /** Whether a player holds a season's premium pass (SeasonPass.hasPass). Omit: no premium track on this server. */
  passHolder?: (address: Address, season: number) => Promise<boolean>;
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
/** How often held rewards re-check whether the player has verified. */
const HOLD_RECHECK_MS = 5 * 60_000;
/** How often the premium pass is re-read for a player who doesn't have it yet (and after a failed read). */
const PREMIUM_RECHECK_MS = 5 * 60_000;
/** A player's own sync (after buying, or opening the pass page) re-reads at most this often. */
const PREMIUM_SYNC_MIN_MS = 10_000;
/** Premium reads per payout tick, so the loop's RPC load and the wait for payouts stay bounded. */
const PREMIUM_READS_PER_TICK = 20;

/**
 * Daily quests, the first-win bonus and the free pack, tracked by the referee from finished matches (it replays
 * every signed move, so progress can't be faked) and paid on-chain through QuestRewards. Payouts are queued and
 * retried until they land; each has a unique claim id, so the contract never pays one twice.
 */
export class Quests {
  private data: Store;
  /**
   * Where an unusable quests file was moved at startup (null if it loaded). Progress and unpaid rewards in it are
   * not loaded; rewards already paid stay claimed on-chain (claim ids are deterministic), so nothing is paid twice.
   */
  readonly setAside: string | null;
  private busy = false;
  readonly periodDays: number;
  readonly packGoal: number;
  readonly packKind: number;
  private now: () => number;

  constructor(private opts: QuestOptions) {
    const empty = (): Store => ({ players: {}, payouts: [], seen: [] });
    const valid = (x: Record<string, unknown>) =>
      typeof x.players === 'object' && x.players !== null && !Array.isArray(x.players) && Array.isArray(x.payouts) && Array.isArray(x.seen);
    ({ data: this.data, setAside: this.setAside } = opts.file ? readJsonOrSetAside(opts.file, empty, { valid }) : { data: empty(), setAside: null });
    this.periodDays = opts.periodDays ?? PACK_PERIOD_DAYS;
    this.packGoal = opts.packGoal ?? Math.round((PACK_GOAL * this.periodDays) / PACK_PERIOD_DAYS);
    this.packKind = opts.packKind ?? 0;
    this.now = opts.now ?? Date.now;
    if (!Number.isInteger(this.periodDays) || this.periodDays < 1) throw new Error(`quest pack period must be a whole number of days, got ${opts.periodDays}`);
    if (!Number.isInteger(this.packGoal) || this.packGoal < 1) throw new Error(`quest pack goal must be at least 1, got ${opts.packGoal}`);
    if (!Number.isInteger(this.packKind) || this.packKind < 0 || this.packKind > 255) throw new Error(`quest pack kind must be 0-255, got ${opts.packKind}`);
  }

  get paysOnChain() { return !!this.opts.rewarder; }

  /** Sends this player's held rewards on the next payout run (they just verified or registered). */
  releaseHeld(address: string) {
    const a = address.toLowerCase();
    for (const p of this.data.payouts) if (p.address === a && p.state === 'held') p.nextAt = 0;
  }

  /** Whether this player can be paid now (null: no rule, or the check failed). */
  async eligibleFor(address: string): Promise<boolean | null> {
    if (!this.opts.eligible) return null;
    try { return await this.opts.eligible(address as Address); } catch { return null; }
  }

  /** Whether this match was already counted. */
  hasSeen(matchId: string): boolean { return this.data.seen.includes(matchId); }

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
      const pass = this.passOf(p, day);
      // House bots count for less (and for at most XP_BOT_DAILY_CAP a day), so the pass can't be farmed against them.
      const vsBot = !!m.players[1 - seat]?.bot;
      if (pass.matchDay !== day) { pass.matchDay = day; pass.matchXp = 0; pass.botXp = 0; }
      const room = Math.min(XP_MATCH_DAILY_CAP - pass.matchXp, vsBot ? XP_BOT_DAILY_CAP - (pass.botXp ?? 0) : Infinity);
      const fromMatch = Math.max(0, Math.min(matchXp(won, vsBot), room));
      pass.matchXp += fromMatch;
      if (vsBot) pass.botXp = (pass.botXp ?? 0) + fromMatch;
      let xp = fromMatch;
      qs.forEach((q, slot) => {
        if (p.today.progress[slot] >= q.goal) return;
        p.today.progress[slot] = Math.min(q.goal, p.today.progress[slot] + q.progress({ seat: seat as 0 | 1, won, race: pl.race, turns: m.turns, events: m.events }));
        if (p.today.progress[slot] < q.goal) return;
        out.push(this.queue(address, 'quest', `${q.id}#${slot}`, day, q.scrap, 0));
        xp += bonusXp(XP_QUEST, vsBot);
        p.periods[period] = (p.periods[period] ?? 0) + 1;
        if (p.periods[period] === this.packGoal) out.push(this.queue(address, 'pack', `pack-${period}`, day, 0, 1));
      });
      if (won && !p.today.firstWin) {
        p.today.firstWin = true;
        out.push(this.queue(address, 'firstWin', 'first-win', day, FIRST_WIN_SCRAP, 0));
        xp += bonusXp(XP_FIRST_WIN, vsBot);
      }
      pass.xp += xp;
      out.push(...this.queuePassTiers(address, p, day));
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

  /** Season pass progress, both tracks and the state of every tier reward. */
  passStatus(address: string): PassStatus {
    const a = address.toLowerCase();
    const day = questDay(this.now());
    const season = passSeason(day);
    const stored = this.data.players[a]?.pass;
    const pass = stored?.season === season.season ? stored : undefined;
    const xp = pass?.xp ?? 0;
    const payout = (track: PassTrack, tier: number) => {
      const x = this.data.payouts.find((y) => y.address === a && y.ref === passRef(season.season, track, tier));
      return x ? { state: x.state, tx: x.tx, error: x.error } : undefined;
    };
    return {
      season: season.season, startsAt: dayStartMs(season.first), endsAt: dayStartMs(season.last + 1),
      xp, tier: tierFor(xp), xpPerTier: PASS_XP_PER_TIER,
      matchXpToday: pass?.matchDay === day ? pass.matchXp : 0, matchXpCap: XP_MATCH_DAILY_CAP,
      botXpToday: pass?.matchDay === day ? pass.botXp ?? 0 : 0, botXpCap: XP_BOT_DAILY_CAP,
      premium: this.opts.passHolder ? pass?.premium === true : null,
      paysOnChain: this.paysOnChain,
      tiers: PASS_TIERS_TABLE.map((t) => ({
        tier: t.tier, free: t.free, premium: t.premium, freePayout: payout('free', t.tier), premiumPayout: payout('premium', t.tier),
      })),
    };
  }

  /** Season cosmetics this player has earned (any season). */
  passCosmetics(address: string): string[] {
    return [...(this.data.players[address.toLowerCase()]?.unlocked ?? [])];
  }

  /**
   * Re-reads whether the player holds this season's premium pass (after a purchase, or on the payout loop) and, once
   * they do, queues the premium rewards for every tier already reached. Returns whether they hold it (null: unknown).
   * `force` (the player's own request) still re-reads at most every `PREMIUM_SYNC_MIN_MS`.
   */
  async syncPremium(address: string, force = false): Promise<boolean | null> {
    const check = this.opts.passHolder;
    if (!check) return null;
    const a = address.toLowerCase();
    const day = questDay(this.now());
    const p = this.player(a, day);
    const pass = this.passOf(p, day);
    if (pass.premium) return true;
    const since = pass.premiumCheckedAt ? this.now() - pass.premiumCheckedAt : Infinity;
    if (since < (force ? PREMIUM_SYNC_MIN_MS : PREMIUM_RECHECK_MS)) return false;
    pass.premiumCheckedAt = this.now(); // a failed read waits like a negative one, so a down RPC isn't hammered
    let has: boolean;
    try { has = await check(a as Address, pass.season); } catch { return null; }
    if (has && !pass.premium) {
      pass.premium = true;
      this.queuePassTiers(a, p, day, pass);
      this.save();
    }
    return has;
  }

  /**
   * One last premium read for a season that has ended: the contract sells a season until its final second, so a pass
   * bought after the last check is only seen here. A failed read retries later; any answer settles the season.
   */
  private async closeSeason(a: string, p: PlayerState, c: ClosingPass): Promise<boolean> {
    let has: boolean;
    try { has = await this.opts.passHolder!(a as Address, c.season); } catch { c.nextAt = this.now() + PREMIUM_RECHECK_MS; return false; }
    p.closing = p.closing?.filter((x) => x !== c);
    if (!p.closing?.length) delete p.closing;
    if (has) {
      c.premium = true;
      this.queuePassTiers(a, p, questDay(this.now()), c);
    }
    return true;
  }

  /** Sends due payouts, one at a time. Failed ones retry with backoff; "already claimed" means it landed before. */
  async payDue(): Promise<{ paid: Payout[]; failed: Payout[] }> {
    const paid: Payout[] = []; const failed: Payout[] = [];
    const r = this.opts.rewarder;
    if (!r || this.busy) return { paid, failed };
    this.busy = true;
    try {
      if (this.opts.passHolder) await this.syncPremiums();
      const eligible = new Map<string, boolean | null>();
      for (const p of this.data.payouts.filter((x) => (x.state === 'pending' || x.state === 'held') && x.nextAt <= this.now())) {
        if (this.opts.eligible) {
          if (!eligible.has(p.address)) eligible.set(p.address, await this.eligibleFor(p.address));
          const ok = eligible.get(p.address);
          if (ok === null) { p.nextAt = this.now() + HOLD_RECHECK_MS; continue; } // RPC trouble: try again later
          if (!ok) {
            if (p.state !== 'held') { p.state = 'held'; this.save(); }
            p.nextAt = this.now() + HOLD_RECHECK_MS;
            continue;
          }
          p.state = 'pending';
        }
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

  /**
   * Premium passes bought since the last check: pay the premium tiers already reached, for the running season and for
   * seasons that ended before their last purchase was seen. At most `PREMIUM_READS_PER_TICK` reads; saves once.
   */
  private async syncPremiums() {
    const day = questDay(this.now());
    const season = passSeason(day).season;
    let reads = 0; let changed = false;
    for (const [a, p] of Object.entries(this.data.players)) {
      if (reads >= PREMIUM_READS_PER_TICK) break;
      // A player who hasn't played since their season ended: move it to closing without waiting for their next match.
      if (p.pass && p.pass.season !== season) { this.passOf(p, day); changed = true; }
      for (const c of p.closing ?? []) { // closeSeason replaces p.closing, so this keeps iterating the old array
        if (reads >= PREMIUM_READS_PER_TICK) break;
        if ((c.nextAt ?? 0) > this.now()) continue;
        reads++;
        if (await this.closeSeason(a, p, c)) changed = true;
      }
      const pass = p.pass;
      if (reads >= PREMIUM_READS_PER_TICK || !pass || pass.premium || pass.xp < PASS_XP_PER_TIER) continue;
      if (pass.premiumCheckedAt && this.now() - pass.premiumCheckedAt < PREMIUM_RECHECK_MS) continue;
      reads++;
      if (await this.syncPremium(a)) changed = true;
    }
    if (changed) this.save();
  }

  private player(address: string, day: number): PlayerState {
    const p = (this.data.players[address] ??= { today: fresh(day), periods: {} });
    if (p.today.day < day) p.today = fresh(day);
    return p;
  }

  /** This season's pass state (a new season starts from zero; cosmetics earned before stay). */
  private passOf(p: PlayerState, day: number): PassState {
    const season = passSeason(day).season;
    if (p.pass?.season !== season) {
      const old = p.pass;
      // Tiers reached without premium seen: read that season's pass once more (it may have been bought at the end).
      if (old && !old.premium && tierFor(old.xp) > 0 && this.opts.passHolder) {
        p.closing = [...(p.closing ?? []), { ...old }].slice(-2);
      }
      p.pass = { season, xp: 0, matchDay: day, matchXp: 0, freeTier: 0, premiumTier: 0 };
    }
    return p.pass;
  }

  /** Queues the rewards (and unlocks the cosmetics) of every tier reached since the last call, per track. */
  private queuePassTiers(address: string, p: PlayerState, day: number, pass: PassState = this.passOf(p, day)): Payout[] {
    const reached = tierFor(pass.xp);
    const out: Payout[] = [];
    const tracks: PassTrack[] = pass.premium ? ['free', 'premium'] : ['free'];
    for (const track of tracks) {
      const key = track === 'free' ? 'freeTier' : 'premiumTier';
      for (let tier = pass[key] + 1; tier <= reached; tier++) {
        const r = PASS_TIERS_TABLE[tier - 1][track];
        if (!r) continue;
        if (r.cosmetic) {
          const id = passCosmeticId(r.cosmetic, pass.season);
          p.unlocked ??= [];
          if (!p.unlocked.includes(id)) p.unlocked.push(id);
        }
        if (r.scrap || r.packs) {
          const ref = passRef(pass.season, track, tier);
          const claimId = keccak256(toHex(`forkfall-pass:${this.opts.chainId}:${address}:${pass.season}:${track}:${tier}`));
          out.push(this.queue(address, 'pass', ref, day, r.scrap ?? 0, r.packs ?? 0, claimId));
        }
      }
      pass[key] = Math.max(pass[key], reached);
    }
    return out;
  }

  /**
   * Queue a reward from another feature (referrals) on the same payout loop: same eligibility gate, retries and
   * daily budget. `claimId` must be unique to the reward, so a retry or a second queue never pays twice.
   */
  queueReward(address: string, kind: Payout['kind'], ref: string, claimId: Hex, scrap: number, packs: number, packKind = 0): Payout {
    const a = address.toLowerCase();
    const existing = this.data.payouts.find((p) => p.claimId === claimId);
    if (existing) return existing;
    const p = this.queue(a, kind, ref, questDay(this.now()), scrap, packs, claimId, packKind);
    this.save();
    return p;
  }

  /** A queued reward's state by claim id (undefined once pruned or never queued). */
  payoutState(claimId: Hex): { state: Payout['state']; tx?: Hex; error?: string } | undefined {
    const p = this.data.payouts.find((x) => x.claimId === claimId);
    return p ? { state: p.state, tx: p.tx, error: p.error } : undefined;
  }

  private queue(address: string, kind: Payout['kind'], ref: string, day: number, scrap: number, packs: number, id?: Hex, packKind = this.packKind): Payout {
    const claimId = id ?? keccak256(toHex(`forkfall-quest:${this.opts.chainId}:${address}:${day}:${ref}`));
    const p: Payout = {
      claimId, address, kind, ref, day, scrap, packKind: packs ? packKind : 0, packs,
      state: this.paysOnChain ? 'pending' : 'offchain', attempts: 0, nextAt: 0,
    };
    this.data.payouts.push(p);
    return p;
  }

  private save() {
    this.prune();
    if (!this.opts.file) return;
    writeFileAtomic(this.opts.file, JSON.stringify(this.data));
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

const passRef = (season: number, track: PassTrack, tier: number) => `pass-s${season}-${track}-${tier}`;

function fresh(day: number): DayState {
  return { day, rerolls: [0, 0, 0], rerollsUsed: 0, progress: [0, 0, 0], firstWin: false };
}
