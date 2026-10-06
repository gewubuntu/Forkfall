import {
  autoBuildSealed, dayStartMs, questDay, randomHex32, RULES_VERSION, SEALED_BOT_AFTER_MS, SEALED_LOSSES, SEALED_PACKS, SEALED_RUN_DAYS,
  SEALED_TITLES, SEALED_WIDEN_MS, SEALED_WINS, sealedPacks, sealedPool, sealedPoolSeed, sealedPrize, sealedRace, validateSealedDeck,
  keccakHex,
} from '@forkfall/engine';
import { commitSeed, ZERO32, type SealedRunView, type SealedStatus } from '@forkfall/sdk';
import { join } from 'node:path';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { ApiError } from './lobby.ts';
import type { Match, Seatholder } from './lobby/types.ts';
import type { Quests } from './quests.ts';
import { readJsonOrSetAside, writeFileAtomic } from './state.ts';

/** Where Sealed runs and titles are kept: apps/server/data/sealed/<chainId>.json. */
export const sealedFile = (root: string, chainId: number) => join(root, 'apps/server/data/sealed', `${chainId}.json`);

const DAY_MS = 86_400_000;
/** Finished runs stay listed (and their pool provable) this long. */
const KEEP_MS = 90 * DAY_MS;
/** Stored runs are bounded: free runs cost nothing, so a flood of fresh wallets must not grow the file without limit. */
const MAX_RUNS = 10_000;
/** Server seeds waiting for their run to start (memory only: a restart just issues a new commitment). */
const MAX_PENDING = 5_000;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

interface Run {
  id: string;
  address: string;
  /** UTC day it started: one free run a day. */
  day: number;
  startedAt: number;
  /** Last activity (a match finished, a deck set): a run left open for SEALED_RUN_DAYS ends. */
  lastAt: number;
  rules: number;
  serverSeed: Hex;
  commit: Hex;
  share: Hex;
  deck?: number[];
  wins: number;
  losses: number;
  matches: { id: Hex; won: boolean; bot: boolean }[];
  state: 'open' | 'finished';
  endedBy?: SealedRunView['endedBy'];
  /** The match in progress, or waiting for both players to join. */
  active?: Hex;
  prize?: { scrap: number; packs: number; titleStep: boolean; claimId?: Hex };
}

interface Store {
  runs: Record<string, Run>;
  titles: Record<string, string[]>;
  /** Finished runs and runs with 5+ wins, per wallet (for the titles; kept after the runs are forgotten). */
  counts: Record<string, { finished: number; strong: number }>;
}

interface QueueEntry { address: string; runId: string; seedCommit: Hex; agent: boolean; at: number }

/** What Sealed needs from the lobby around it. */
export interface SealedHost {
  matches: Map<Hex, Match>;
  houseAddress: Address;
  sealedMatch(players: [Seatholder, Seatholder], runs: [string | null, string | null]): Match;
  eligibleFor(address: Address, declaredAgent: boolean): Promise<boolean>;
}

export interface SealedOptions {
  file?: string;
  chainId: number;
  /** Pays prizes on the quest payout loop (same eligibility gate, retries and budget). */
  quests: Quests;
  host: SealedHost;
  now?: () => number;
}

const lc = (a: string) => a.toLowerCase();

/**
 * Sealed runs: 6 packs rolled from a commit-reveal seed, a deck built from them, a record of wins and losses until
 * 7 or 3, played as casual matches between Sealed decks (a house bot plays you if nobody does within 45 s). The
 * pool is derived (never stored): `sealedPacks(sealedPoolSeed(serverSeed, share, id), rules)`.
 */
export class Sealed {
  private data: Store;
  readonly setAside: string | null;
  private now: () => number;
  private queue = new Map<string, QueueEntry>();
  private pending = new Map<string, { serverSeed: Hex; commit: Hex }>();
  private busy = false;

  constructor(private opts: SealedOptions) {
    const empty = (): Store => ({ runs: {}, titles: {}, counts: {} });
    const valid = (x: Record<string, unknown>) => typeof x.runs === 'object' && x.runs !== null && typeof x.titles === 'object' && x.titles !== null;
    ({ data: this.data, setAside: this.setAside } = opts.file ? readJsonOrSetAside(opts.file, empty, { valid }) : { data: empty(), setAside: null });
    this.data.counts ??= {};
    this.now = opts.now ?? Date.now;
  }

  /** Sealed titles this wallet has earned (to merge into what it may equip). */
  titles(address: string): string[] { return [...(this.data.titles[lc(address)] ?? [])]; }

  // ─── Reads ───────────────────────────────────────────────────
  status(address: string): SealedStatus {
    const a = lc(address);
    const open = this.openRun(a);
    if (open) this.reconcile(open);
    const mine = Object.values(this.data.runs).filter((r) => r.address === a).sort((x, y) => y.startedAt - x.startedAt);
    const today = questDay(this.now());
    const last = mine[0];
    const startedToday = !!last && last.day === today;
    const current = mine.find((r) => r.state === 'open');
    return {
      pending: { commit: this.pendingFor(a).commit },
      run: current ? this.view(current) : null,
      history: mine.filter((r) => r.state === 'finished').slice(0, 10).map((r) => this.view(r)),
      canStart: !current && !startedToday,
      nextStartAt: !current && startedToday ? dayStartMs(today + 1) : null,
      titles: this.titles(a),
      rules: { wins: SEALED_WINS, losses: SEALED_LOSSES, packs: SEALED_PACKS, botAfterMs: SEALED_BOT_AFTER_MS, widenMs: SEALED_WIDEN_MS },
    };
  }

  private view(r: Run): SealedRunView {
    const m = r.active ? this.opts.host.matches.get(r.active) : undefined;
    const q = this.queue.get(r.address);
    return {
      id: r.id, state: r.state, startedAt: r.startedAt, wins: r.wins, losses: r.losses,
      packs: sealedPacks(sealedPoolSeed(r.serverSeed, r.share, r.id), r.rules),
      deck: r.deck ?? null, rules: r.rules, commit: r.commit, share: r.share,
      ...(r.state === 'finished' ? { serverSeed: r.serverSeed } : {}),
      ...(r.endedBy ? { endedBy: r.endedBy } : {}),
      matches: r.matches,
      activeMatch: m ? { id: m.id, phase: m.phase } : null,
      queued: q && q.runId === r.id ? { since: q.at, botAt: q.at + SEALED_BOT_AFTER_MS } : null,
      prize: r.prize ? {
        scrap: r.prize.scrap, packs: r.prize.packs, titleStep: r.prize.titleStep,
        payout: r.prize.claimId ? this.opts.quests.payoutState(r.prize.claimId) : undefined,
      } : null,
    };
  }

  private pendingFor(a: string) {
    let p = this.pending.get(a);
    if (!p) {
      if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
      const serverSeed = randomHex32() as Hex;
      p = { serverSeed, commit: commitSeed(serverSeed) };
      this.pending.set(a, p);
    }
    return p;
  }

  private openRun(a: string): Run | undefined {
    return Object.values(this.data.runs).find((r) => r.address === a && r.state === 'open');
  }

  // ─── Runs ────────────────────────────────────────────────────
  /** Start today's free run: the pool is rolled from the committed server seed, your share and the run id. */
  start(address: string, share: string): SealedStatus {
    const a = lc(address);
    if (!HEX32.test(share ?? '')) throw new ApiError(400, 'share (bytes32) required');
    const open = this.openRun(a);
    if (open) throw new ApiError(409, 'finish or abandon your open run first');
    const today = questDay(this.now());
    if (Object.values(this.data.runs).some((r) => r.address === a && r.day === today)) {
      throw new ApiError(409, `one free run a day: the next one starts ${new Date(dayStartMs(today + 1)).toISOString()}`);
    }
    const p = this.pendingFor(a);
    this.pending.delete(a);
    const id = keccakHex('forkfall-run', a, p.commit).slice(2, 18);
    this.data.runs[id] = {
      id, address: a, day: today, startedAt: this.now(), lastAt: this.now(), rules: RULES_VERSION, serverSeed: p.serverSeed, commit: p.commit,
      share: share as Hex, wins: 0, losses: 0, matches: [], state: 'open',
    };
    this.save();
    return this.status(a);
  }

  /** Set the deck: 30 cards from the pool and the basics. Not while a match is in progress or queued. */
  setDeck(address: string, deck: unknown): SealedStatus {
    const a = lc(address);
    const run = this.requireOpen(a);
    this.reconcile(run);
    if (run.active || this.queue.has(a)) throw new ApiError(409, 'leave the queue and finish your match before changing your deck');
    if (!Array.isArray(deck) || !deck.every((x) => Number.isInteger(x))) throw new ApiError(400, 'deck must be a list of card ids');
    const pool = sealedPool(sealedPacks(sealedPoolSeed(run.serverSeed, run.share, run.id), run.rules));
    const chk = validateSealedDeck(deck as number[], pool);
    if (!chk.ok) throw new ApiError(400, chk.errors.join('; '));
    run.deck = deck as number[];
    run.lastAt = this.now();
    this.save();
    return this.status(a);
  }

  /** Join the queue: same record first, a house bot after 45 s. */
  async enqueue(address: Address, seedCommit: string, declaredAgent: boolean): Promise<SealedStatus> {
    const a = lc(address);
    if (!HEX32.test(seedCommit ?? '')) throw new ApiError(400, 'seedCommit (bytes32) required');
    const run = this.requireOpen(a);
    this.reconcile(run);
    if (!run.deck) throw new ApiError(409, 'build your deck first');
    if (run.active) throw new ApiError(409, 'you have a match in progress');
    const agent = await this.opts.host.eligibleFor(address, declaredAgent);
    if (run.state !== 'open' || run.active) throw new ApiError(409, 'your run changed: try again');
    this.queue.set(a, { address: a, runId: run.id, seedCommit: seedCommit as Hex, agent, at: this.now() });
    return this.status(a);
  }

  leave(address: string): SealedStatus {
    this.queue.delete(lc(address));
    return this.status(address);
  }

  /** End the run with its record (a prize is paid only if a match was played). */
  abandon(address: string): SealedStatus {
    const a = lc(address);
    const run = this.requireOpen(a);
    this.reconcile(run);
    if (run.state === 'open') this.finish(run, 'abandoned');
    return this.status(a);
  }

  private requireOpen(a: string): Run {
    const run = this.openRun(a);
    if (!run) throw new ApiError(409, 'no open Sealed run: start one first');
    return run;
  }

  // ─── Results ─────────────────────────────────────────────────
  /** A finished Sealed match: count it for each human seat's run (idempotent per match). */
  recordMatch(m: Match) {
    if (m.format !== 'sealed' || m.phase !== 'ended') return;
    m.sealed?.forEach((id, seat) => {
      const run = id ? this.data.runs[id] : undefined;
      if (run) this.apply(run, m, seat);
    });
    this.save();
  }

  /** Catch up a match that ended while nobody was listening (a restart), or drop one that never started. */
  private reconcile(run: Run) {
    if (!run.active) return;
    const m = this.opts.host.matches.get(run.active);
    if (!m || m.phase === 'cancelled') { run.active = undefined; this.save(); return; }
    if (m.phase === 'ended') {
      const seat = m.sealed?.findIndex((id) => id === run.id) ?? -1;
      this.apply(run, m, seat >= 0 ? seat : lc(m.players[0].address) === run.address ? 0 : 1);
      this.save();
    }
  }

  private apply(run: Run, m: Match, seat: number) {
    if (run.state !== 'open' || run.matches.some((x) => x.id === m.id)) { if (run.active === m.id) run.active = undefined; return; }
    // A win is a recorded winner that is this wallet; a draw (or a missing result) counts as a loss for both.
    const won = !!m.result && lc(m.result.winner) === run.address;
    run.matches.push({ id: m.id, won, bot: !!m.players[1 - seat]?.bot });
    if (won) run.wins++; else run.losses++;
    run.lastAt = this.now();
    if (run.active === m.id) run.active = undefined;
    if (run.wins >= SEALED_WINS) this.finish(run, 'wins');
    else if (run.losses >= SEALED_LOSSES) this.finish(run, 'losses');
  }

  private finish(run: Run, by: NonNullable<Run['endedBy']>) {
    if (run.state === 'finished') return;
    run.state = 'finished';
    run.endedBy = by;
    run.active = undefined;
    this.queue.delete(run.address);
    const prize = sealedPrize(run.wins);
    if (run.matches.length > 0) {
      const claimId = keccak256(toHex(`forkfall-sealed:${this.opts.chainId}:${run.address}:${run.id}`));
      run.prize = { ...prize, claimId };
      this.opts.quests.queueReward(run.address, 'sealed', `sealed-${run.id}`, claimId, prize.scrap, prize.packs);
    }
    const c = (this.data.counts[run.address] ??= { finished: 0, strong: 0 });
    const earn = (id: string) => { const t = (this.data.titles[run.address] ??= []); if (!t.includes(id)) t.push(id); };
    if (by === 'wins' || by === 'losses') { c.finished++; earn(SEALED_TITLES.rookie.id); }
    if (run.wins >= 5) c.strong++;
    if (c.strong >= 3) earn(SEALED_TITLES.veteran.id);
    if (run.wins >= SEALED_WINS) earn(SEALED_TITLES.unsealed.id);
    this.save();
  }

  // ─── The loop ────────────────────────────────────────────────
  /** Expire stale runs, pair the queue (same record first, one step wider per 10 s) and match the left-over with a bot. */
  tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      for (const run of Object.values(this.data.runs)) {
        if (run.state !== 'open') continue;
        this.reconcile(run);
        if (run.state === 'open' && !run.active && now - run.lastAt > SEALED_RUN_DAYS * DAY_MS) this.finish(run, 'expired');
      }
      const entries = [...this.queue.values()].filter((e) => {
        const run = this.data.runs[e.runId];
        const ok = !!run && run.state === 'open' && !run.active && !!run.deck;
        if (!ok) this.queue.delete(e.address);
        return ok;
      }).sort((x, y) => x.at - y.at);
      const paired = new Set<string>();
      for (const a of entries) {
        if (paired.has(a.address)) continue;
        const ra = this.data.runs[a.runId];
        let best: QueueEntry | undefined;
        let bestGap = Infinity;
        for (const b of entries) {
          if (b === a || paired.has(b.address) || b.address === a.address) continue;
          const rb = this.data.runs[b.runId];
          const gap = Math.abs(ra.wins - rb.wins) + Math.abs(ra.losses - rb.losses);
          const allowed = Math.floor(Math.max(now - a.at, now - b.at) / SEALED_WIDEN_MS);
          if (gap <= allowed && gap < bestGap) { best = b; bestGap = gap; }
        }
        if (best) { this.pair(a, best); paired.add(a.address); paired.add(best.address); }
      }
      for (const e of entries) if (!paired.has(e.address) && now - e.at >= SEALED_BOT_AFTER_MS) this.pairBot(e);
    } finally { this.busy = false; }
  }

  private seat(e: QueueEntry, run: Run): Seatholder {
    const deck = run.deck!;
    return { address: e.address as Address, race: sealedRace(deck), deck, deckId: ZERO32, agent: e.agent, seedCommit: e.seedCommit };
  }

  private pair(a: QueueEntry, b: QueueEntry) {
    const ra = this.data.runs[a.runId];
    const rb = this.data.runs[b.runId];
    const m = this.opts.host.sealedMatch([this.seat(a, ra), this.seat(b, rb)], [ra.id, rb.id]);
    ra.active = m.id; rb.active = m.id;
    this.queue.delete(a.address); this.queue.delete(b.address);
    this.save();
  }

  /** Nobody to play: a house bot with its own Sealed deck (rolled from its own seed) takes the seat. */
  private pairBot(e: QueueEntry) {
    const run = this.data.runs[e.runId];
    const botSeed = keccakHex('forkfall-sealed-bot', run.id, String(run.matches.length), randomHex32());
    const botDeck = autoBuildSealed(sealedPool(sealedPacks(botSeed, run.rules)));
    const seedShare = randomHex32() as Hex;
    const bot: Seatholder = {
      address: this.opts.host.houseAddress, race: sealedRace(botDeck), deck: botDeck, deckId: ZERO32, agent: true,
      seedCommit: commitSeed(seedShare), seedShare, deckSalt: randomHex32() as Hex, bot: 'greedy',
    };
    const m = this.opts.host.sealedMatch([this.seat(e, run), bot], [run.id, null]);
    run.active = m.id;
    this.queue.delete(e.address);
    this.save();
  }

  private save() {
    this.prune();
    if (!this.opts.file) return;
    writeFileAtomic(this.opts.file, JSON.stringify(this.data));
  }

  /** Forget finished runs after 90 days, and the oldest finished ones if the store is full. */
  private prune() {
    const now = this.now();
    const all = Object.values(this.data.runs);
    for (const r of all) if (r.state === 'finished' && r.startedAt < now - KEEP_MS) delete this.data.runs[r.id];
    const left = Object.values(this.data.runs);
    if (left.length > MAX_RUNS) {
      for (const r of left.filter((x) => x.state === 'finished').sort((x, y) => x.startedAt - y.startedAt).slice(0, left.length - MAX_RUNS)) delete this.data.runs[r.id];
    }
  }
}
