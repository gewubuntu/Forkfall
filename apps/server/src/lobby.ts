import {
  applyAction, combineSeeds, createMatch, eventsFor, forfeit, keccakHex, legalActions, randomHex32,
  RACES, starterDeck, validateDeck, viewFor,
  type Action, type Equipped, type GameEvent, type GameState, type Race, type Seat,
} from '@forkfall/engine';
import {
  actionHash, commitSeed, eloUpdate, MODES, START_RATING, MOVE_TYPES, RESULT_TYPES, moveDigest, nextHead, replayLog, resultDigest, viewGreedy, ZERO32, ZERO_ADDRESS,
  type Delegation, type MatchLog, type MatchResult, type MatchSnapshot, type MatchSummary, type Mode,
} from '@forkfall/sdk';
import { recoverAddress, type Address, type Hex, type LocalAccount, type TypedDataDomain } from 'viem';
import type { Chain, LeagueOps, RefereeSettler } from './chain.ts';
import type { LiveBus } from './live.ts';
import type { StateStore } from './state.ts';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type BotKind = 'greedy' | 'random';

interface Seatholder {
  address: Address;
  race: Race;
  deck: number[];
  deckId: Hex;
  agent: boolean;
  seedCommit: Hex;
  seedShare?: Hex;
  deckSalt?: Hex;
  bot?: BotKind;
  resultSig?: Hex;
  /** SIWE delegations for every session key that signed a move for this seat (makes the log verifiable). */
  delegations?: Delegation[];
}

interface LoggedMove {
  seq: number;
  seat: Seat;
  action: Action;
  signature: Hex | null; // null = referee-forced (timeout)
  head: Hex;
}

export interface Match {
  id: Hex;
  mode: Mode;
  season: number;
  createdAt: number;
  phase: 'reveal' | 'active' | 'ended' | 'cancelled';
  players: [Seatholder, Seatholder];
  state?: GameState;
  events: GameEvent[];
  moves: LoggedMove[];
  head: Hex;
  clock: { turnStartedAt: number; bank: [number, number]; timeouts: [number, number] };
  endedAt?: number;
  result?: MatchResult;
  /** Referee co-signature over the result (required on-chain for ranked / Human queue). */
  refereeSig?: Hex;
  /** Auto-settlement by the referee when the loser never signs. */
  referee?: RefereeSettlement;
  /** Agent League: entry fees charged on-chain when the match starts (pending → charged), or why it failed. */
  league?: {
    state: 'charging' | 'charged' | 'failed'; tx?: Hex; error?: string;
    /** While charging: when to check again (the outcome of the last attempt is unknown), and how many times it read "not started". */
    retryAt?: number; notStarted?: number;
    /** After giving up: keep checking until then, in case a transaction still pending lands and needs refunding. */
    watchUntil?: number;
  };
  /** Friend challenge this match came from (casual). */
  challenge?: string;
  /** Time the referee was down while this match waited for its reveals (doesn't count against the reveal window). */
  pausedMs?: number;
  /**
   * Finished and unloaded to save memory: `state`, `events` and `moves` are empty and live in the archive until
   * someone opens the match (`full`). What's kept is what lists, settlement and the leaderboard need.
   */
  cold?: { endReason?: GameState['endReason']; seq: number };
  /** Last time the full match was used (ms): finished matches idle for a while are unloaded. */
  usedAt?: number;
  /** The latest change to this finished match is in the archive, so it may be unloaded. */
  archived?: boolean;
}

/** A running (not yet finished) match on disk: everything but the game state, which is rebuilt by replaying the moves. */
export interface SavedMatch {
  v: 1;
  savedAt: number;
  match: Omit<Match, 'state' | 'events'>;
}

/** Queue, tickets and challenges on disk. `aliveAt` is refreshed while the referee runs, to measure downtime. */
export interface SavedLobby {
  v: 1;
  aliveAt: number;
  queue: QueueEntry[];
  matchedTickets: [string, Hex][];
  byAddressTicket: [Address, string][];
  challenges: Challenge[];
}

export interface RefereeSettlement {
  state: 'submitting' | 'settled' | 'failed';
  tx?: Hex;
  error?: string;
  attempts: number;
  /** Retry after a failed attempt (ms timestamp). */
  retryAt?: number;
}

export interface LobbyOptions {
  chain: Chain;
  /** Equipped cosmetics per player, shown to everyone in the match. */
  profiles?: { equipped(address: string): Equipped };
  house: LocalAccount;
  turnSeconds?: number;
  bankSeconds?: number;
  revealSeconds?: number;
  /** After this long without the loser's signature, the referee path opens. */
  resultGraceSeconds?: number;
  maxTimeouts?: number;
  /** Queue entries whose client stops polling for this long are dropped (default 30 s). */
  queueTtlSeconds?: number;
  now?: () => number;
  botDelayMs?: number;
  /** When set, the referee submits `settleByReferee` itself once the loser's grace period is over. */
  settler?: RefereeSettler | null;
  /** Attempts before giving up on auto-settling a match (default 3). */
  settleAttempts?: number;
  /** Agent League (paid agents-only queue); null/absent = league disabled. */
  league?: LeagueOps | null;
  /** League charges: wait between checks of a failed charge's outcome (default 20 s). */
  leagueRecheckMs?: number;
  /** Where running matches, the queue and challenges survive a restart (absent = memory only). */
  store?: StateStore | null;
  /**
   * Reads a finished match back from the archive. With it, finished matches are restored without replaying
   * them, and unloaded after `unloadAfterSeconds` idle; they are replayed again when someone opens one.
   */
  archive?: { load(matchId: Hex): ArchivedMatch | null } | null;
  /** Idle time before a finished, archived match is unloaded (default 600 s). */
  unloadAfterSeconds?: number;
}

/** What the server keeps on disk for a finished match: the public log plus the collected signatures. */
export interface ArchivedMatch {
  log: MatchLog;
  refereeSig?: Hex;
  referee?: RefereeSettlement;
  resultSigs: [Hex | null, Hex | null];
  bots: [BotKind | null, BotKind | null];
}

/**
 * A finished match without its moves and the players' secrets (decks, seed reveals, delegations): what an unloaded
 * match keeps in memory, and what the archive index stores so a restart doesn't read every archive file.
 */
export interface ArchiveSummary extends Omit<ArchivedMatch, 'log'> {
  log: Omit<MatchLog, 'moves' | 'players'> & {
    moveCount: number;
    players: Pick<MatchLog['players'][number], 'address' | 'race' | 'deckId' | 'agent' | 'seedCommit'>[];
  };
}

export function summarize(rec: ArchivedMatch): ArchiveSummary {
  const { moves, players, ...log } = rec.log;
  return {
    ...rec,
    log: {
      ...log, moveCount: moves.length,
      players: players.map((p) => ({ address: p.address, race: p.race, deckId: p.deckId, agent: p.agent, seedCommit: p.seedCommit })),
    },
  };
}

/** A friend challenge: a casual match waiting for one opponent (anyone with the link, or one address). */
export interface Challenge {
  code: string;
  from: Seatholder;
  /** Only this address may accept (a directed challenge or a rematch). */
  to?: Address;
  /** The match this is a rematch of. */
  rematchOf?: Hex;
  createdAt: number;
  expiresAt: number;
  state: 'open' | 'accepted' | 'cancelled' | 'declined';
  matchId?: Hex;
  /** When it was accepted, cancelled or declined (for pruning). */
  closedAt?: number;
}

/** What anyone may see of a challenge. The challenger's race stays hidden until the match starts. */
export interface ChallengeView {
  code: string;
  from: { address: Address; agent: boolean; cosmetics?: Equipped };
  to: Address | null;
  rematchOf: Hex | null;
  state: Challenge['state'] | 'expired';
  createdAt: number;
  expiresAt: number;
  /** Only returned here to the two players (once it starts, the match is listed publicly like any other). */
  matchId?: Hex;
  /** The match's phase, for the two players: 'reveal' means it is waiting for both to join. */
  matchPhase?: Match['phase'];
}

export const CHALLENGE_TTL_MS = 24 * 3600_000;
export const MAX_OPEN_CHALLENGES = 5;
/** Open challenges addressed to one wallet, from everyone (keeps a target's incoming list from being flooded). */
export const MAX_INCOMING_CHALLENGES = 20;
/** A challenge match waits this long for both players to join (the challenger may be in another tab). */
export const CHALLENGE_REVEAL_MS = 3 * 60_000;
/** Answered or expired challenges are forgotten after this. */
const CHALLENGE_KEEP_MS = 3600_000;

/**
 * Rated queues pair players whose ratings are close: within ±100 at first, 50 wider every 10 s of waiting, and
 * anyone in the queue after a minute, so a thin queue never leaves someone waiting for a perfect match.
 */
export const RATING_WINDOW = { start: 100, step: 50, everyMs: 10_000, anyoneAfterMs: 60_000 } as const;
export function ratingWindow(waitedMs: number): number {
  if (waitedMs >= RATING_WINDOW.anyoneAfterMs) return Infinity;
  return RATING_WINDOW.start + RATING_WINDOW.step * Math.floor(Math.max(0, waitedMs) / RATING_WINDOW.everyMs);
}

interface QueueEntry {
  ticket: string;
  address: Address;
  mode: Mode;
  race: Race;
  deck: number[];
  deckId: Hex;
  agent: boolean;
  seedCommit: Hex;
  at: number;
  /** Last time the client checked its queue status; entries that go quiet are dropped. */
  seen: number;
  /** League: the agent's operator (owner of its ERC-8004 identity); never paired with the same operator. */
  operator?: Address;
  /** Rated modes: the player's rating when they joined (season stats, or the league week's standing). */
  rating?: number;
}

/**
 * The referee. Runs the one rules engine, verifies each EIP-712-signed move against the
 * log hash chain, enforces the shared 45s + 60s-bank timer, and assembles the settlement.
 */
export class Lobby {
  readonly matches = new Map<Hex, Match>();
  private queue: QueueEntry[] = [];
  private matchedTickets = new Map<string, Hex>();
  private byAddressTicket = new Map<Address, string>();
  private challenges = new Map<string, Challenge>();
  readonly turnMs: number;
  readonly bankMs: number;
  readonly revealMs: number;
  readonly graceMs: number;
  readonly maxTimeouts: number;
  readonly queueTtlMs: number;
  readonly now: () => number;
  readonly domain: TypedDataDomain;
  /**
   * Called on every change. For a finished match, return false if it could not be archived: its running-match
   * file is then kept (and the archive retried at the next restart) instead of being dropped.
   */
  onChange?: (m: Match) => void | boolean;
  private leagueInFlight = new Set<Hex>();
  /** Live notices to connected clients (set by the API); everything works without it, just by polling. */
  bus?: LiveBus;

  constructor(readonly opts: LobbyOptions) {
    this.turnMs = (opts.turnSeconds ?? 45) * 1000;
    this.bankMs = (opts.bankSeconds ?? 60) * 1000;
    this.revealMs = (opts.revealSeconds ?? 60) * 1000;
    this.graceMs = (opts.resultGraceSeconds ?? 600) * 1000;
    this.maxTimeouts = opts.maxTimeouts ?? 3;
    this.queueTtlMs = (opts.queueTtlSeconds ?? 30) * 1000;
    this.now = opts.now ?? Date.now;
    this.domain = { name: 'Forkfall', version: '1', chainId: opts.chain.chainId, verifyingContract: opts.chain.settlement };
  }

  // ─── Deck resolution ──────────────────────────────────────────
  private async resolveDeck(address: Address, mode: Mode, race: Race, deck?: number[], deckId?: Hex) {
    const ranked = mode !== 'casual';
    if (!RACES.includes(race)) throw new ApiError(400, 'unknown race');
    if (deckId && this.opts.chain.online) {
      const d = await this.opts.chain.deck(deckId, address, ranked);
      if (!d) throw new ApiError(400, 'deck not registered to you, no longer owned, or not ranked-legal');
      if (RACES[d.race - 1] !== race) throw new ApiError(400, 'deck race mismatch');
      return { deck: d.cardIds, deckId };
    }
    if (ranked && this.opts.chain.online) throw new ApiError(400, 'ranked play needs a deckId registered in DeckRegistry');
    const list = deck ?? starterDeck(race);
    const chk = validateDeck(race, list, ranked);
    if (!chk.ok) throw new ApiError(400, chk.errors.join('; '));
    return { deck: list, deckId: deckId ?? ZERO32 };
  }

  private async checkEligibility(address: Address, mode: Mode, declaredAgent: boolean): Promise<boolean> {
    const agent = declaredAgent || (await this.opts.chain.isAgent(address));
    if (mode !== 'casual' && (await this.opts.chain.isBanned(address))) throw new ApiError(403, 'banned from ranked');
    // Human queue: open to every wallet that is not an agent. Verification only gates season rewards.
    if (mode === 'human' && agent) throw new ApiError(403, 'agents cannot join the Human queue');
    return agent;
  }

  /** League entry: a registered agent with enough prepaid balance for the entry fee (402 = deposit first). */
  private async leagueEntry(address: Address): Promise<Address> {
    const league = this.opts.league;
    if (!league) throw new ApiError(503, 'the Agent League is not available on this server (no AgentLeague contract)');
    const [operator, balance, fee] = await Promise.all([league.operatorOf(address), league.balanceOf(address), league.entryFee()]);
    if (/^0x0{40}$/i.test(operator)) throw new ApiError(403, 'the Agent League is for registered agents (ERC-8004 AgentRegistry)');
    if (balance < fee) {
      throw new ApiError(402, `league balance too low: deposit at least ${Number(fee - balance) / 1e6} tUSDC into AgentLeague (entry fee ${Number(fee) / 1e6} per match)`);
    }
    return operator;
  }

  // ─── Queue ────────────────────────────────────────────────────
  async enqueue(address: Address, body: { mode: Mode; race: Race; deck?: number[]; deckId?: Hex; seedCommit: Hex }, agent: boolean) {
    if (!(body.mode in MODES)) throw new ApiError(400, 'unknown mode');
    if (!/^0x[0-9a-fA-F]{64}$/.test(body.seedCommit ?? '')) throw new ApiError(400, 'seedCommit (bytes32) required');
    this.leaveQueue(address);
    const gen = this.queueGen.get(address.toLowerCase());
    const isAgent = await this.checkEligibility(address, body.mode, agent);
    const { deck, deckId } = await this.resolveDeck(address, body.mode, body.race, body.deck, body.deckId);
    const operator = body.mode === 'league' ? await this.leagueEntry(address) : undefined;
    const season = await this.seasonFor(body.mode);
    const rating = body.mode === 'casual' ? undefined : await this.ratingOf(address, body.mode, season);
    // While we awaited the chain, the player left the queue or queued again: that request wins, this one stops here
    // (otherwise a cancelled request could still pair them, or two requests put them in two matches).
    if (this.queueGen.get(address.toLowerCase()) !== gen) throw new ApiError(409, 'queue request cancelled by a newer one');
    const ticket = keccakHex(address, String(this.now()), randomHex32());
    const me: QueueEntry = { ticket, address, mode: body.mode, race: body.race, deck, deckId, agent: isAgent, seedCommit: body.seedCommit, at: this.now(), seen: this.now(), operator, rating };
    this.byAddressTicket.set(address, ticket);
    this.pruneQueue();
    const idx = this.opponentFor(me, this.now());
    if (idx < 0) {
      this.queue.push(me);
      return { status: 'queued' as const, ticket };
    }
    const [opp] = this.queue.splice(idx, 1);
    const m = this.pair(opp, me, season);
    return { status: 'matched' as const, ticket, matchId: m.id };
  }

  /** League results carry the league week as their season, rated modes the ladder season, casual none. */
  private async seasonFor(mode: Mode): Promise<number> {
    if (mode === 'casual') return 0;
    if (mode !== 'league') return this.opts.chain.season();
    if (!this.opts.league) throw new ApiError(503, 'the Agent League is not enabled on this referee');
    return this.opts.league.currentWeek();
  }

  /**
   * A rated player's rating for pairing. Ranked and the Human queue share the season's on-chain Elo; off-chain the
   * referee replays the same Elo over the rated matches it refereed. League agents use their weekly standing.
   */
  private async ratingOf(address: Address, mode: Mode, season: number): Promise<number> {
    if (mode === 'league') {
      try { return (await this.opts.league?.rating?.(season, address)) ?? START_RATING; } catch { return START_RATING; }
    }
    try {
      const onChain = await this.opts.chain.rating(season, address);
      if (onChain !== null) return onChain;
    } catch (e) { console.error(`could not read the rating of ${address}; estimating it from refereed matches`, e); }
    return this.localRating(season, address);
  }

  /** The season's Elo as MatchSettlement computes it, replayed over the ranked and Human queue matches refereed here. */
  localRating(season: number, address: Address): number {
    const ended = [...this.matches.values()]
      .filter((m) => m.phase === 'ended' && m.result && m.season === season && m.mode !== 'casual' && m.mode !== 'league')
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    const ratings = new Map<string, number>();
    const get = (a: Address) => ratings.get(a.toLowerCase()) ?? START_RATING;
    for (const m of ended) {
      const [a, b] = m.players.map((p) => p.address);
      const w = m.result!.winner;
      const [na, nb] = eloUpdate(get(a), get(b), w === ZERO_ADDRESS ? 500 : same(w, a) ? 1000 : 0);
      ratings.set(a.toLowerCase(), na);
      ratings.set(b.toLowerCase(), nb);
    }
    return get(address);
  }

  /**
   * The queue entry `me` should play: same mode, not themselves, never two agents of one operator in the league
   * (no farming your own pot), and in rated modes within either player's rating window. Closest rating first, then
   * whoever has waited longest. -1 when nobody fits yet.
   */
  private opponentFor(me: QueueEntry, now: number): number {
    let best = -1;
    let bestGap = Infinity;
    this.queue.forEach((q, i) => {
      if (q === me || q.mode !== me.mode || same(q.address, me.address)) return;
      if (me.mode === 'league' && q.operator?.toLowerCase() === me.operator?.toLowerCase()) return;
      const gap = me.mode === 'casual' ? 0 : Math.abs((q.rating ?? START_RATING) - (me.rating ?? START_RATING));
      if (gap > Math.max(ratingWindow(now - me.at), ratingWindow(now - q.at))) return;
      if (gap < bestGap) { best = i; bestGap = gap; } // the queue is in arrival order, so ties go to the longest wait
    });
    return best;
  }

  private pair(first: QueueEntry, second: QueueEntry, season: number): Match {
    const m = this.newMatch(first.mode, season, [this.seatFrom(first), this.seatFrom(second)]);
    this.matchedTickets.set(first.ticket, m.id);
    this.matchedTickets.set(second.ticket, m.id);
    return m;
  }

  private sweeping = false;
  /**
   * Pair waiting players whose rating windows have widened enough to meet (an arrival pairs at once if it can;
   * this catches the ones who waited). Runs every tick; the oldest waiter picks first.
   */
  async matchQueue(): Promise<void> {
    if (this.sweeping) return;
    this.pruneQueue();
    const due = this.now();
    // Only modes where someone can be paired right now, so a waiting queue costs no season reads.
    const modes = [...new Set(this.queue.filter((q) => this.opponentFor(q, due) >= 0).map((q) => q.mode))];
    if (!modes.length) return;
    this.sweeping = true;
    try {
      // A mode whose season can't be read (RPC down, league no longer configured) waits; the others still pair.
      const read = await Promise.allSettled(modes.map((mode) => this.seasonFor(mode)));
      const seasons = new Map<Mode, number>();
      read.forEach((r, i) => {
        if (r.status === 'fulfilled') seasons.set(modes[i], r.value);
        else console.error(`queue matching: could not read the ${modes[i]} season`, r.reason);
      });
      this.pruneQueue();
      const now = this.now();
      for (let i = 0; i < this.queue.length; i++) {
        const me = this.queue[i];
        const season = seasons.get(me.mode);
        if (season === undefined) continue;
        const j = this.opponentFor(me, now);
        if (j < 0) continue;
        const opp = this.queue[j];
        this.queue = this.queue.filter((q) => q !== me && q !== opp);
        this.pair(me, opp, season);
        i = -1; // the queue changed: start again from the longest waiter
      }
    } finally {
      this.sweeping = false;
    }
  }

  private seatFrom(q: QueueEntry): Seatholder {
    return { address: q.address, race: q.race, deck: q.deck, deckId: q.deckId, agent: q.agent, seedCommit: q.seedCommit };
  }

  queueStatus(address: Address) {
    const ticket = this.byAddressTicket.get(address);
    if (!ticket) return { status: 'idle' as const };
    const matchId = this.matchedTickets.get(ticket);
    if (matchId) return { status: 'matched' as const, ticket, matchId };
    const entry = this.queue.find((q) => q.ticket === ticket);
    if (!entry) return { status: 'idle' as const };
    entry.seen = this.now();
    return { status: 'queued' as const, ticket };
  }

  /** Drop queue entries whose client stopped polling, so nobody gets matched with a ghost. */
  private pruneQueue() {
    const cutoff = this.now() - this.queueTtlMs;
    this.queue = this.queue.filter((q) => q.seen >= cutoff);
  }

  /** Bumped by every leave (and so every enqueue): an enqueue still awaiting the chain knows it was superseded. */
  private queueGen = new Map<string, number>();

  leaveQueue(address: Address) {
    const key = address.toLowerCase();
    this.queueGen.set(key, (this.queueGen.get(key) ?? 0) + 1);
    this.queue = this.queue.filter((q) => q.address !== address);
  }

  // ─── Friend challenges (casual) ───────────────────────────────
  /** Create a challenge link. Casual only: ranked between friends would invite win trading. */
  async createChallenge(address: Address, body: { race: Race; deck?: number[]; deckId?: Hex; seedCommit: Hex; to?: string; rematchOf?: Hex }, agent: boolean) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(body.seedCommit ?? '')) throw new ApiError(400, 'seedCommit (bytes32) required');
    if (!RACES.includes(body.race)) throw new ApiError(400, 'unknown race');
    let to: Address | undefined;
    if (body.to !== undefined && body.to !== null && body.to !== '') {
      if (!/^0x[0-9a-fA-F]{40}$/.test(body.to)) throw new ApiError(400, 'to must be an address');
      to = body.to.toLowerCase() as Address;
      if (to === address.toLowerCase()) throw new ApiError(400, 'you can’t challenge yourself');
    }
    if (body.rematchOf) {
      const prev = this.matches.get(body.rematchOf);
      if (!prev || prev.phase !== 'ended') throw new ApiError(400, 'rematch: no such finished match');
      const me = this.seatOf(prev, address);
      if (me === null) throw new ApiError(403, 'rematch: you didn’t play that match');
      const opp = prev.players[me === 0 ? 1 : 0];
      if (opp.bot) throw new ApiError(400, 'rematch the house bot from Play instead');
      to = opp.address.toLowerCase() as Address;
    }
    this.pruneChallenges();
    const live = [...this.challenges.values()].filter((c) => c.state === 'open' && this.now() <= c.expiresAt);
    if (live.filter((c) => same(c.from.address, address)).length >= MAX_OPEN_CHALLENGES) {
      throw new ApiError(429, `at most ${MAX_OPEN_CHALLENGES} open challenges: cancel one first`);
    }
    if (to && live.filter((c) => c.to && same(c.to, to!)).length >= MAX_INCOMING_CHALLENGES) {
      throw new ApiError(429, 'that player has too many pending challenges right now');
    }
    const isAgent = await this.checkEligibility(address, 'casual', agent);
    const { deck, deckId } = await this.resolveDeck(address, 'casual', body.race, body.deck, body.deckId);
    const code = challengeCode();
    const c: Challenge = {
      code, from: { address, race: body.race, deck, deckId, agent: isAgent, seedCommit: body.seedCommit },
      to, rematchOf: body.rematchOf, createdAt: this.now(), expiresAt: this.now() + CHALLENGE_TTL_MS, state: 'open',
    };
    this.challenges.set(code, c);
    if (to) this.bus?.user(to, 'challenge', { code });
    return this.challengeView(c, address);
  }

  challenge(code: string): Challenge {
    const c = this.challenges.get(code);
    if (!c) throw new ApiError(404, 'no such challenge (it may have expired)');
    return c;
  }

  challengeView(c: Challenge, viewer: Address | null): ChallengeView {
    const expired = c.state === 'open' && this.now() > c.expiresAt;
    const player = viewer && (same(c.from.address, viewer) || (c.matchId && this.matches.get(c.matchId)?.players.some((p) => same(p.address, viewer))));
    return {
      code: c.code,
      from: { address: c.from.address, agent: c.from.agent, ...(this.opts.profiles ? { cosmetics: this.opts.profiles.equipped(c.from.address) } : {}) },
      to: c.to ?? null, rematchOf: c.rematchOf ?? null,
      state: expired ? 'expired' : c.state, createdAt: c.createdAt, expiresAt: c.expiresAt,
      ...(player && c.matchId ? { matchId: c.matchId, matchPhase: this.matches.get(c.matchId)?.phase } : {}),
    };
  }

  /** Accept: the match starts right away (both reveal as usual). */
  async acceptChallenge(address: Address, code: string, body: { race: Race; deck?: number[]; deckId?: Hex; seedCommit: Hex }, agent: boolean) {
    const c = this.challenge(code);
    if (c.state !== 'open') throw new ApiError(409, `this challenge was already ${c.state}`);
    if (this.now() > c.expiresAt) throw new ApiError(410, 'this challenge has expired');
    if (same(c.from.address, address)) throw new ApiError(400, 'you can’t accept your own challenge');
    if (c.to && !same(c.to, address)) throw new ApiError(403, 'this challenge is for someone else');
    if (!/^0x[0-9a-fA-F]{64}$/.test(body.seedCommit ?? '')) throw new ApiError(400, 'seedCommit (bytes32) required');
    if (!RACES.includes(body.race)) throw new ApiError(400, 'unknown race');
    const isAgent = await this.checkEligibility(address, 'casual', agent);
    const { deck, deckId } = await this.resolveDeck(address, 'casual', body.race, body.deck, body.deckId);
    if (c.state !== 'open') throw new ApiError(409, `this challenge was already ${c.state}`); // raced while we awaited
    if (this.now() > c.expiresAt) throw new ApiError(410, 'this challenge has expired');
    // A copy of the challenger's seat: if this match is cancelled before it starts, the link reopens untouched.
    const m = this.newMatch('casual', 0, [{ ...c.from }, { address, race: body.race, deck, deckId, agent: isAgent, seedCommit: body.seedCommit }]);
    m.challenge = c.code;
    c.state = 'accepted';
    c.matchId = m.id;
    c.closedAt = this.now();
    this.bus?.user(c.from.address, 'challenge', { code: c.code, matchId: m.id });
    return { matchId: m.id, challenge: this.challengeView(c, address) };
  }

  /** The challenger cancels, or the addressee declines. */
  closeChallenge(address: Address, code: string) {
    const c = this.challenge(code);
    if (c.state !== 'open') throw new ApiError(409, `this challenge was already ${c.state}`);
    if (same(c.from.address, address)) c.state = 'cancelled';
    else if (c.to && same(c.to, address)) c.state = 'declined';
    else throw new ApiError(403, 'only the challenger can cancel, or the challenged player decline');
    c.closedAt = this.now();
    const other = c.state === 'cancelled' ? c.to : c.from.address;
    if (other) this.bus?.user(other, 'challenge', { code: c.code });
    return this.challengeView(c, address);
  }

  /** Your open and recent challenges, and open ones addressed to you. */
  challengesFor(address: Address) {
    this.pruneChallenges();
    const all = [...this.challenges.values()].sort((a, b) => b.createdAt - a.createdAt);
    return {
      outgoing: all.filter((c) => same(c.from.address, address)).map((c) => this.challengeView(c, address)),
      incoming: all.filter((c) => c.to && same(c.to, address) && c.state === 'open' && this.now() <= c.expiresAt)
        .slice(0, MAX_INCOMING_CHALLENGES).map((c) => this.challengeView(c, address)),
    };
  }

  /** Forget challenges an hour after they expired or were answered (an accepted one once its match is under way). */
  private pruneChallenges() {
    const cutoff = this.now() - CHALLENGE_KEEP_MS;
    for (const [k, c] of this.challenges) {
      const waiting = c.matchId && this.matches.get(c.matchId)?.phase === 'reveal';
      if (!waiting && ((c.closedAt ?? Infinity) < cutoff || c.expiresAt < cutoff)) this.challenges.delete(k);
    }
  }

  /** A challenge match cancelled before it started (someone never joined): reopen the link while it's valid. */
  private reopenChallenge(m: Match) {
    const c = m.challenge ? this.challenges.get(m.challenge) : undefined;
    if (!c || c.matchId !== m.id || c.state !== 'accepted') return;
    c.matchId = undefined;
    c.closedAt = undefined;
    c.state = this.now() <= c.expiresAt ? 'open' : 'cancelled';
    this.bus?.user(c.from.address, 'challenge', { code: c.code });
  }

  /** Casual match vs a house bot. The bot is badged as an agent and sees only its own view. */
  async practice(address: Address, body: { race: Race; deck?: number[]; seedCommit: Hex; bot?: BotKind; botRace?: Race }, agent: boolean) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(body.seedCommit ?? '')) throw new ApiError(400, 'seedCommit (bytes32) required');
    const { deck } = await this.resolveDeck(address, 'casual', body.race, body.deck);
    const botRace = body.botRace ?? RACES[Math.floor(Math.random() * 4)];
    const seedShare = randomHex32() as Hex;
    const deckSalt = randomHex32() as Hex;
    const botSeat: Seatholder = {
      address: this.opts.house.address, race: botRace, deck: starterDeck(botRace), deckId: ZERO32, agent: true,
      seedCommit: commitSeed(seedShare), seedShare, deckSalt, bot: body.bot ?? 'greedy',
    };
    const human: Seatholder = { address, race: body.race, deck, deckId: ZERO32, agent, seedCommit: body.seedCommit };
    const m = this.newMatch('casual', 0, [human, botSeat]);
    return { matchId: m.id };
  }

  private newMatch(mode: Mode, season: number, players: [Seatholder, Seatholder]): Match {
    const id = keccakHex('forkfall-match', randomHex32(), String(this.now())) as Hex;
    const m: Match = {
      id, mode, season: mode === 'casual' ? 0 : season, createdAt: this.now(), phase: 'reveal', players,
      events: [], moves: [], head: ZERO32, clock: { turnStartedAt: 0, bank: [this.bankMs, this.bankMs], timeouts: [0, 0] },
    };
    this.matches.set(id, m);
    this.save(m);
    this.maybeStart(m);
    // Both players hear about their new match at once (queue pairing, an accepted challenge, practice).
    for (const p of players) if (!p.bot) this.bus?.user(p.address, 'match', { matchId: id });
    this.bus?.lobby();
    return m;
  }

  // ─── Reveal & start ───────────────────────────────────────────
  reveal(address: Address, matchId: Hex, seedShare: Hex, deckSalt: Hex) {
    const m = this.get(matchId);
    const seat = this.seatOf(m, address);
    if (seat === null) throw new ApiError(403, 'not a player in this match');
    if (m.phase !== 'reveal') throw new ApiError(409, 'already revealed');
    const p = m.players[seat];
    if (commitSeed(seedShare) !== p.seedCommit) throw new ApiError(400, 'seed share does not match commitment');
    if (!/^0x[0-9a-fA-F]{2,64}$/.test(deckSalt ?? '')) throw new ApiError(400, 'deckSalt must be hex');
    p.seedShare = seedShare;
    p.deckSalt = deckSalt;
    this.save(m);
    this.maybeStart(m);
    return { ok: true, phase: m.phase };
  }

  private maybeStart(m: Match) {
    if (m.phase !== 'reveal' || !m.players.every((p) => p.seedShare && p.deckSalt)) return;
    // League: charge both entry fees on-chain first (only once both agents showed up); start when mined.
    if (m.mode === 'league' && m.league?.state !== 'charged') {
      if (m.league) return; // charging in flight, or failed
      m.league = { state: 'charging' };
      this.save(m);
      this.chargeLeague(m);
      return;
    }
    const r = this.initialState(m);
    m.state = r.state;
    m.events.push(...r.events);
    m.phase = 'active';
    m.clock.turnStartedAt = this.now();
    this.changed(m);
  }

  private initialState(m: Match) {
    const [a, b] = m.players;
    return createMatch({
      matchId: m.id, seed: combineSeeds(m.id, a.seedShare!, b.seedShare!),
      players: [
        { address: a.address, race: a.race, deck: a.deck, deckSalt: a.deckSalt! },
        { address: b.address, race: b.race, deck: b.deck, deckSalt: b.deckSalt! },
      ],
    });
  }

  /**
   * Charge both league entry fees. The outcome of a failed call isn't always known (an RPC error, or a receipt
   * that timed out while the transaction is still pending), so a failure is only final once the chain has said
   * "not started" a few times, some time apart. Until then the match stays `charging` and is re-checked from
   * `tick`. If it turns out started, it counts as charged; a match cancelled after a charge is refunded on-chain.
   */
  private chargeLeague(m: Match) {
    const ops = this.opts.league!;
    if (this.leagueInFlight.has(m.id)) return;
    this.leagueInFlight.add(m.id);
    (async () => {
      // A retry first asks the chain: the earlier attempt may have gone through.
      if ((m.league?.notStarted ?? 0) > 0 || m.league?.retryAt !== undefined) {
        if (await ops.started(m.id)) return { tx: m.league?.tx };
      }
      return { tx: await ops.start(m.id, m.players[0].address, m.players[1].address) };
    })().then(
      ({ tx }) => { m.league = { state: 'charged', tx }; this.save(m); this.maybeStart(m); },
      async (e) => {
        let started: boolean | null;
        try { started = await ops.started(m.id); } catch { started = null; }
        if (started) { m.league = { state: 'charged' }; this.save(m); this.maybeStart(m); return; }
        const notStarted = (m.league?.notStarted ?? 0) + (started === false ? 1 : 0);
        if (notStarted >= LEAGUE_CHARGE_CHECKS) {
          // Gave up, but a transaction still pending could land later: watch for it and refund if it does.
          const at = this.now() + (this.opts.leagueRecheckMs ?? LEAGUE_RECHECK_MS);
          m.league = { state: 'failed', error: (e as Error).message, retryAt: at, watchUntil: this.now() + LEAGUE_WATCH_MS };
          m.phase = 'cancelled'; this.changed(m);
          return;
        }
        m.league = { state: 'charging', error: (e as Error).message, notStarted, retryAt: this.now() + (this.opts.leagueRecheckMs ?? LEAGUE_RECHECK_MS) };
        this.save(m);
      },
    ).finally(() => this.leagueInFlight.delete(m.id));
  }

  /** A league match that won't be played after all: refund both entry fees if they were charged. */
  private refundLeague(m: Match) {
    const ops = this.opts.league;
    if (!ops || m.mode !== 'league') return;
    ops.started(m.id)
      .then((started) => (started ? ops.cancel(m.id) : null))
      .then((tx) => { if (tx) console.log(`league match ${m.id} cancelled on-chain, entry fees refunded (${tx})`); })
      .catch((e) => console.error(`could not refund league match ${m.id}: ${(e as Error).message}`));
  }

  // ─── Moves ────────────────────────────────────────────────────
  async submitMove(
    address: Address, matchId: Hex, seq: number, action: Action, signature: Hex,
    session?: { sessionKey: Address; delegation: Delegation },
  ) {
    const m = this.get(matchId);
    if (m.phase !== 'active') throw new ApiError(409, `match is ${m.phase}`);
    const seat = this.seatOf(m, address);
    if (seat === null) throw new ApiError(403, 'not a player in this match');
    if (seq !== m.moves.length) throw new ApiError(409, `stale seq: expected ${m.moves.length}`);
    const aHash = actionHash(action);
    const digest = moveDigest(this.domain, { matchId, seq, prevHash: m.head, actionHash: aHash });
    const signer = await recoverAddress({ hash: digest, signature }).catch(() => null);
    const bySessionKey = !!session && signer?.toLowerCase() === session.sessionKey.toLowerCase();
    if (!signer || (signer.toLowerCase() !== address.toLowerCase() && !bySessionKey)) throw new ApiError(401, 'bad move signature');
    if (bySessionKey) {
      const p = m.players[seat];
      p.delegations ??= [];
      if (!p.delegations.some((d) => d.signature === session!.delegation.signature)) p.delegations.push(session!.delegation);
    }
    this.apply(m, seat, action, signature);
    return this.snapshot(m, address);
  }

  private apply(m: Match, seat: Seat, action: Action, signature: Hex | null) {
    let r;
    try { r = applyAction(m.state!, seat, action); } catch (e) { throw new ApiError(422, (e as Error).message); }
    const prevActive = m.state!.active;
    m.head = nextHead(m.head, seat, actionHash(action)) as Hex;
    m.moves.push({ seq: m.moves.length, seat, action, signature, head: m.head });
    m.state = r.state;
    m.events.push(...r.events);
    if (action.type === 'endTurn') {
      const over = Math.max(0, this.now() - m.clock.turnStartedAt - this.turnMs);
      m.clock.bank[prevActive] = Math.max(0, m.clock.bank[prevActive] - over);
      if (signature) m.clock.timeouts[prevActive] = 0;
    }
    if (r.state.active !== prevActive) m.clock.turnStartedAt = this.now();
    if (r.state.status === 'ended') this.finish(m);
    this.changed(m);
  }

  private finish(m: Match) {
    m.phase = 'ended';
    m.endedAt = this.now();
    m.usedAt = m.endedAt;
    const s = m.state!;
    const [a, b] = m.players;
    m.result = {
      matchId: m.id, playerA: a.address, playerB: b.address,
      winner: s.winner === 'draw' || s.winner === null ? ZERO_ADDRESS : m.players[s.winner].address,
      deckA: a.deckId, deckB: b.deckId, mode: MODES[m.mode], season: m.season, turns: s.turn, logHash: m.head,
    };
    // The referee attests every result it refereed; house bots co-sign right away too.
    void this.houseSignResult(m).then(() => this.changed(m));
  }

  // ─── Clock (call every second) ────────────────────────────────
  tick() {
    const now = this.now();
    this.pruneQueue();
    this.matchQueue().catch((e) => console.error('queue matching failed', e));
    this.pruneChallenges();
    this.pruneTickets();
    this.unloadIdle(now);
    for (const m of this.matches.values()) {
      if (m.phase === 'reveal' && m.league?.state === 'charging' && m.league.retryAt !== undefined && now >= m.league.retryAt) {
        this.chargeLeague(m);
        continue;
      }
      if (m.league?.state === 'failed' && m.league.watchUntil !== undefined && m.league.retryAt !== undefined && now >= m.league.retryAt) {
        const l = m.league;
        if (now > l.watchUntil!) { l.watchUntil = undefined; continue; }
        l.retryAt = now + (this.opts.leagueRecheckMs ?? LEAGUE_RECHECK_MS);
        this.opts.league?.started(m.id).then((started) => {
          if (!started) return;
          l.watchUntil = undefined;
          this.refundLeague(m); // the charge landed after we gave up: give both fees back
        }, () => { /* ask again next time */ });
        continue;
      }
      const revealWindow = m.challenge ? CHALLENGE_REVEAL_MS : this.revealMs;
      if (m.phase === 'reveal' && now - m.createdAt - (m.pausedMs ?? 0) > revealWindow && m.league?.state !== 'charging') {
        m.phase = 'cancelled'; this.reopenChallenge(m); this.changed(m);
        if (m.league?.state === 'charged') this.refundLeague(m);
        continue;
      }
      if (m.phase !== 'active') continue;
      const seat = m.state!.active;
      const deadline = m.clock.turnStartedAt + this.turnMs + m.clock.bank[seat];
      if (now < deadline) continue;
      m.clock.bank[seat] = 0;
      m.clock.timeouts[seat] += 1;
      if (m.clock.timeouts[seat] >= this.maxTimeouts) {
        const r = forfeit(m.state!, seat);
        m.state = r.state;
        m.events.push(...r.events);
        this.finish(m);
        this.changed(m);
      } else {
        this.apply(m, seat, { type: 'endTurn' }, null);
      }
    }
  }

  /** Drive house bots. Returns true if a bot moved. */
  async stepBots(): Promise<boolean> {
    let moved = false;
    for (const m of this.matches.values()) {
      // Finished: only a backstop for a missing house signature (finish() normally signs). Saved, so it's archived.
      if (m.phase === 'ended') {
        if (this.needsHouseSig(m)) { await this.houseSignResult(m); this.changed(m); }
        continue;
      }
      if (m.phase !== 'active') continue;
      const seat = m.state!.active;
      const p = m.players[seat];
      if (!p.bot) continue;
      const snap = this.snapshot(m, p.address);
      const action = p.bot === 'random' ? pickRandom(snap) : viewGreedy(snap);
      const sig = await this.opts.house.signTypedData({
        domain: this.domain, types: MOVE_TYPES, primaryType: 'Move',
        message: { matchId: m.id, seq: m.moves.length, prevHash: m.head, actionHash: actionHash(action) },
      });
      this.apply(m, seat, action, sig);
      moved = true;
    }
    return moved;
  }

  /** The house still owes a signature on this result: the referee's, or a house bot's. */
  private needsHouseSig(m: Match): boolean {
    return !!m.result && (!m.refereeSig || m.players.some((p) => p.bot && !p.resultSig));
  }

  private async houseSignResult(m: Match) {
    if (m.result && !m.refereeSig) {
      m.refereeSig = await this.opts.house.signTypedData({ domain: this.domain, types: RESULT_TYPES, primaryType: 'MatchResult', message: { ...m.result } });
    }
    for (const p of m.players) {
      if (p.bot && !p.resultSig && m.result) {
        p.resultSig = await this.opts.house.signTypedData({ domain: this.domain, types: RESULT_TYPES, primaryType: 'MatchResult', message: { ...m.result } });
      }
    }
  }

  // ─── Results & settlement ─────────────────────────────────────
  resultFor(matchId: Hex) {
    const m = this.get(matchId);
    if (!m.result) throw new ApiError(409, 'match not finished');
    return { result: m.result, domain: this.domain, digest: resultDigest(this.domain, m.result) };
  }

  async submitResultSig(address: Address, matchId: Hex, signature: Hex) {
    // Loaded (and verified) first: a signature that can't be archived must fail now, not be lost at the next restart.
    const m = this.full(this.get(matchId));
    const seat = this.seatOf(m, address);
    if (seat === null) throw new ApiError(403, 'not a player in this match');
    if (!m.result) throw new ApiError(409, 'match not finished');
    // Smart wallets (ERC-1271/6492) are checked on-chain when the server has an RPC; EOAs by recovery.
    const client = this.opts.chain.client;
    const ok = client
      ? await client.verifyTypedData({
        address, signature, domain: this.domain, types: RESULT_TYPES, primaryType: 'MatchResult', message: { ...m.result },
      }).catch(() => false)
      : (await recoverAddress({ hash: resultDigest(this.domain, m.result), signature }).catch(() => null))?.toLowerCase() === address.toLowerCase();
    if (!ok) throw new ApiError(401, 'bad result signature');
    m.players[seat].resultSig = signature;
    this.changed(m);
    return { ok: true as const, complete: m.players.every((p) => p.resultSig) };
  }

  /** JSON consumed by `forge script script/Play.s.sol --sig "settle(string)"`. */
  settlement(matchId: Hex) {
    const m = this.get(matchId);
    if (!m.result) throw new ApiError(409, 'match not finished');
    const [a, b] = m.players;
    const base = { domain: { ...this.domain, chainId: Number(this.domain.chainId) }, result: m.result };
    if (a.resultSig && b.resultSig && (m.refereeSig || m.mode === 'casual')) {
      return { ...base, byReferee: false, sigA: a.resultSig, sigB: b.resultSig, refereeSig: m.refereeSig ?? '0x' };
    }
    const winnerSeat = m.result.winner === a.address ? 0 : m.result.winner === b.address ? 1 : null;
    const opensAt = this.refereeOpensAt(m);
    if (winnerSeat !== null && m.players[winnerSeat].resultSig && opensAt !== null && this.now() >= opensAt) {
      return { ...base, byReferee: true, winnerSig: m.players[winnerSeat].resultSig, note: 'submit with the REFEREE key' };
    }
    throw new ApiError(409, 'waiting for result signatures');
  }

  log(matchId: Hex): MatchLog {
    const m = this.get(matchId);
    if (m.phase !== 'ended') throw new ApiError(409, 'full log (with seed reveals) is public after the match ends');
    this.full(m);
    return {
      matchId: m.id, mode: m.mode, season: m.season, createdAt: m.createdAt, endedAt: m.endedAt, endReason: m.state?.endReason,
      domain: { ...this.domain, chainId: Number(this.domain.chainId) },
      players: m.players.map((p) => ({ address: p.address, race: p.race, deck: p.deck, deckId: p.deckId, agent: p.agent, seedCommit: p.seedCommit, seedShare: p.seedShare!, deckSalt: p.deckSalt!, delegations: p.delegations ?? [] })),
      moves: m.moves, head: m.head, result: m.result!,
    };
  }

  // ─── Archive (finished matches survive a restart) ─────────────
  archive(matchId: Hex): ArchivedMatch {
    const m = this.get(matchId);
    return {
      log: this.log(matchId),
      refereeSig: m.refereeSig,
      referee: m.referee?.state === 'submitting' ? undefined : m.referee,
      resultSigs: [m.players[0].resultSig ?? null, m.players[1].resultSig ?? null],
      bots: [m.players[0].bot ?? null, m.players[1].bot ?? null],
    };
  }

  /** Whether a log or summary was signed for this deployment (same chain and MatchSettlement). */
  ownDomain(d: TypedDataDomain): boolean {
    return Number(d.chainId) === Number(this.domain.chainId)
      && String(d.verifyingContract).toLowerCase() === String(this.domain.verifyingContract).toLowerCase();
  }

  /**
   * Re-load an archived match by replaying its log, which verifies it (seeds, hash chain, and the result against
   * the moves). Returns false if it belongs to another deployment or fails to replay. With an archive loader it
   * is unloaded again on the next tick.
   */
  restore(rec: ArchivedMatch): boolean {
    const { log } = rec;
    if (this.matches.has(log.matchId)) return true;
    if (!this.ownDomain(log.domain)) return false;
    const replay = replayLog(log);
    if (!replay.ok) return false;
    const players = archivedSeats(rec);
    this.matches.set(log.matchId, {
      id: log.matchId, mode: log.mode, season: log.season ?? log.result.season, createdAt: log.createdAt ?? 0, endedAt: log.endedAt,
      phase: 'ended', players, state: replay.final, events: replay.frames.flatMap((f) => f.events),
      moves: log.moves, head: log.head, clock: { turnStartedAt: 0, bank: [0, 0], timeouts: [0, 0] },
      result: log.result, refereeSig: rec.refereeSig, referee: rec.referee,
      archived: true, usedAt: 0,
    });
    return true;
  }

  /**
   * Re-load a finished match unloaded, from the summary the server wrote when it archived it (no replay: that data
   * came from the match as it was played). It's replayed from its archive file when someone opens it.
   */
  restoreSummary(s: ArchiveSummary): boolean {
    const { log } = s;
    if (this.matches.has(log.matchId)) return true;
    if (!this.ownDomain(log.domain)) return false;
    this.matches.set(log.matchId, {
      id: log.matchId, mode: log.mode, season: log.season ?? log.result.season, createdAt: log.createdAt ?? 0, endedAt: log.endedAt,
      phase: 'ended', events: [], moves: [], head: log.head,
      players: log.players.map((p, i): Seatholder => ({
        ...p, deck: [], resultSig: s.resultSigs[i] ?? undefined, bot: s.bots[i] ?? undefined,
      })) as [Seatholder, Seatholder],
      clock: { turnStartedAt: 0, bank: [0, 0], timeouts: [0, 0] },
      result: log.result, refereeSig: s.refereeSig, referee: s.referee,
      cold: { endReason: log.endReason, seq: log.moveCount }, archived: true, usedAt: 0,
    });
    return true;
  }

  /**
   * The whole match, reloaded from the archive if it was unloaded (replayed once, then kept until it is idle
   * again). Signatures and settlement state stay those in memory: they are at least as new as the file.
   */
  private full(m: Match): Match {
    m.usedAt = this.now();
    if (!m.cold) return m;
    const rec = this.opts.archive?.load(m.id);
    const replay = rec && rec.log.matchId === m.id ? replayLog(rec.log) : null;
    if (!rec || !replay?.ok) throw new ApiError(500, `archived match ${m.id} could not be loaded and verified`);
    rec.log.players.forEach((p, i) => {
      Object.assign(m.players[i], { deck: p.deck, seedShare: p.seedShare, deckSalt: p.deckSalt, delegations: p.delegations });
    });
    m.state = replay.final;
    m.events = replay.frames.flatMap((f) => f.events);
    m.moves = rec.log.moves;
    m.head = rec.log.head;
    m.cold = undefined;
    return m;
  }

  /** Unload finished matches nobody has opened for a while (only once their latest change is archived). */
  private unloadIdle(now: number) {
    if (!this.opts.archive) return;
    const idleMs = (this.opts.unloadAfterSeconds ?? 600) * 1000;
    for (const m of this.matches.values()) {
      if (m.phase !== 'ended' || m.cold || !m.archived || now - (m.usedAt ?? 0) < idleMs) continue;
      m.cold = { endReason: m.state?.endReason, seq: m.moves.length };
      m.state = undefined;
      m.events = [];
      m.moves = [];
      for (const p of m.players) { p.deck = []; p.delegations = undefined; }
    }
  }

  private endReason(m: Match) { return m.cold ? m.cold.endReason : m.state?.endReason; }

  /**
   * When the referee may settle with the winner's signature alone: right away after a timeout or
   * concede, otherwise once the loser's grace period is over. Null for draws (both must sign).
   */
  refereeOpensAt(m: Match): number | null {
    if (!m.result || m.result.winner === ZERO_ADDRESS || m.endedAt === undefined) return null;
    const endReason = this.endReason(m);
    const instant = endReason === 'timeout' || endReason === 'concede';
    return instant ? m.endedAt : m.endedAt + this.graceMs;
  }

  /** Matches the referee settles on its own: rated or casual between real players (not house-bot practice). */
  private autoSettles(m: Match): boolean {
    return !!this.opts.settler && !m.players.some((p) => p.bot);
  }

  /**
   * Submit `settleByReferee` for every finished match whose loser never signed and whose grace period
   * is over. Idempotent: checks `settled` on-chain first. Call periodically.
   */
  async settleDue(): Promise<{ settled: Hex[]; failed: { matchId: Hex; error: string }[] }> {
    const out = { settled: [] as Hex[], failed: [] as { matchId: Hex; error: string }[] };
    const settler = this.opts.settler;
    if (!settler) return out;
    const maxAttempts = this.opts.settleAttempts ?? 3;
    for (const m of this.matches.values()) {
      if (m.phase !== 'ended' || !m.result || !this.autoSettles(m)) continue;
      const r = m.referee;
      if (r && (r.state !== 'failed' || r.attempts >= maxAttempts || (r.retryAt ?? 0) > this.now())) continue;
      let s;
      try { s = this.settlement(m.id); } catch { continue; } // still waiting for the winner's signature
      // Fully signed: players settle it themselves, except league matches, which the referee submits.
      if (!('winnerSig' in s) && m.mode !== 'league') continue;
      // Never submit a result whose archive doesn't load and replay to it (an unloaded match isn't verified yet).
      try { this.full(m); } catch (e) {
        const error = (e as Error).message;
        m.referee = { state: 'failed', attempts: maxAttempts, error };
        out.failed.push({ matchId: m.id, error });
        continue;
      }
      m.referee = { state: 'submitting', attempts: (r?.attempts ?? 0) + 1 };
      this.changed(m);
      try {
        if (await settler.isSettled(m.id)) {
          m.referee = { ...m.referee, state: 'settled' };
        } else {
          const tx = 'winnerSig' in s
            ? await settler.settleByReferee(m.result, s.winnerSig)
            : await settler.settle(m.result, s.sigA, s.sigB, s.refereeSig);
          m.referee = { ...m.referee, state: 'settled', tx };
        }
        out.settled.push(m.id);
      } catch (e) {
        const error = (e as Error).message;
        const attempts = m.referee.attempts;
        m.referee = { state: 'failed', attempts, error, retryAt: attempts < maxAttempts ? this.now() + 60_000 * attempts : undefined };
        out.failed.push({ matchId: m.id, error });
      }
      this.changed(m);
    }
    return out;
  }

  /** Who can settle right now: nobody yet, anyone with the signatures, or only the referee. */
  settlementStatus(m: Match): MatchSummary['settlement'] {
    if (m.phase !== 'ended' || !m.result) return 'none';
    try { return this.settlement(m.id).byReferee ? 'referee' : 'ready'; } catch { return 'waiting'; }
  }

  // ─── Views ────────────────────────────────────────────────────
  get(matchId: Hex): Match {
    const m = this.matches.get(matchId);
    if (!m) throw new ApiError(404, 'no such match');
    return m;
  }

  seatOf(m: Match, address: Address | null): Seat | null {
    if (!address) return null;
    const i = m.players.findIndex((p) => p.address.toLowerCase() === address.toLowerCase());
    return i < 0 ? null : (i as Seat);
  }

  snapshot(m: Match, address: Address | null): MatchSnapshot {
    this.full(m);
    const seat = this.seatOf(m, address);
    const s = m.state;
    return {
      matchId: m.id,
      phase: m.phase,
      mode: m.mode,
      seat,
      players: m.players.map((p) => ({ address: p.address, race: p.race, agent: p.agent, ...(p.bot ? { bot: true } : {}), ...(this.opts.profiles ? { cosmetics: this.opts.profiles.equipped(p.address) } : {}) })),
      ...(m.challenge ? { challenge: m.challenge } : {}),
      view: s ? viewFor(s, seat) : null,
      legalActions: s && seat !== null && s.active === seat ? legalActions(s, seat) : [],
      seq: m.moves.length,
      head: m.head,
      clock: s && m.phase === 'active'
        ? { active: s.active, turnEndsAt: m.clock.turnStartedAt + this.turnMs, bank: [...m.clock.bank] as [number, number] }
        : null,
      eventCount: m.events.length,
      result: m.result,
      now: this.now(),
      resultSigned: [!!m.players[0].resultSig, !!m.players[1].resultSig],
      ...this.refereeInfo(m),
    };
  }

  /** Auto-settlement schedule and status, for players waiting on an opponent who never signs. */
  private refereeInfo(m: Match): Pick<MatchSummary, 'refereeAt' | 'referee'> {
    if (m.phase !== 'ended' || !this.autoSettles(m)) return {};
    const r = m.referee;
    return {
      refereeAt: this.refereeOpensAt(m),
      ...(r ? { referee: { state: r.state, tx: r.tx, error: r.error, willRetry: r.state === 'failed' && r.retryAt !== undefined } } : {}),
    };
  }

  eventsSince(m: Match, address: Address | null, since: number) {
    this.full(m);
    const seat = this.seatOf(m, address);
    const slice = m.events.slice(since);
    return { events: eventsFor(slice, seat), next: m.events.length };
  }

  /** Recent matches, or one player's full history (newest first). */
  list(player?: Address | null): MatchSummary[] {
    const mine = player ? (m: Match) => this.seatOf(m, player) !== null : () => true;
    return [...this.matches.values()]
      .filter((m) => m.phase !== 'cancelled' && mine(m))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, player ? 500 : 50)
      .map((m) => ({
        matchId: m.id, mode: m.mode, phase: m.phase, turn: m.state?.turn ?? m.result?.turns ?? 0, season: m.season,
        createdAt: m.createdAt, endedAt: m.endedAt, endReason: this.endReason(m),
        practice: m.players.some((p) => !!p.bot),
        players: m.players.map((p) => ({ address: p.address, race: p.race, agent: p.agent, deckId: p.deckId })),
        winner: m.result?.winner,
        resultSigned: [!!m.players[0].resultSig, !!m.players[1].resultSig],
        settlement: this.settlementStatus(m),
        ...this.refereeInfo(m),
      }));
  }

  async leaderboard(season?: number) {
    const s = season ?? (await this.opts.chain.season());
    const rows = new Map<string, { address: Address; agent: boolean; wins: number; losses: number; draws: number }>();
    for (const m of this.matches.values()) {
      if (m.phase !== 'ended' || !m.result || m.mode === 'casual' || m.season !== s) continue;
      for (const p of m.players) {
        const r = rows.get(p.address) ?? { address: p.address, agent: p.agent, wins: 0, losses: 0, draws: 0 };
        if (m.result.winner === ZERO_ADDRESS) r.draws++; else if (m.result.winner === p.address) r.wins++; else r.losses++;
        rows.set(p.address, r);
      }
    }
    return { season: s, rows: [...rows.values()].sort((a, b) => b.wins - a.wins || a.losses - b.losses) };
  }

  // ─── Surviving restarts ───────────────────────────────────────
  /** Write a running match to disk (finished ones go to the archive instead, via onChange). */
  private save(m: Match, keepEnded = false) {
    const store = this.opts.store;
    if (!store) return;
    const file = `matches/${m.id}.json`;
    try {
      if (m.phase === 'cancelled' || (m.phase === 'ended' && !keepEnded)) { store.remove(file); return; }
      const { state: _state, events: _events, ...match } = m;
      store.write(file, { v: 1, savedAt: this.now(), match } satisfies SavedMatch);
    } catch (e) { console.error(`could not save match ${m.id}`, e); } // keep playing; it just won't survive a restart
  }

  /** The queue, tickets and challenges, for `restoreLobby`. */
  saveLobby(): SavedLobby {
    return {
      v: 1, aliveAt: this.now(), queue: this.queue,
      matchedTickets: [...this.matchedTickets], byAddressTicket: [...this.byAddressTicket], challenges: [...this.challenges.values()],
    };
  }

  /** A ticket answers "matched" while its match runs; once that match is over (or gone), forget it. */
  private pruneTickets() {
    for (const [t, id] of this.matchedTickets) {
      const phase = this.matches.get(id)?.phase;
      if (phase !== 'reveal' && phase !== 'active') this.matchedTickets.delete(t);
    }
    const live = new Set([...this.queue.map((q) => q.ticket), ...this.matchedTickets.keys()]);
    for (const [a, t] of this.byAddressTicket) if (!live.has(t)) this.byAddressTicket.delete(a);
  }

  restoreLobby(rec: SavedLobby) {
    if (rec?.v !== 1) return;
    this.queue = rec.queue ?? [];
    this.matchedTickets = new Map(rec.matchedTickets ?? []);
    this.byAddressTicket = new Map(rec.byAddressTicket ?? []);
    this.challenges = new Map((rec.challenges ?? []).map((c) => [c.code, c]));
    // Queued clients keep polling through a restart; give them the TTL again rather than dropping them at once.
    // Downtime isn't waiting either: rating windows pick up where they were.
    const down = rec.aliveAt ? Math.max(0, this.now() - rec.aliveAt) : 0;
    for (const q of this.queue) { q.seen = this.now(); q.at += down; }
  }

  /**
   * Bring back a running match after a restart: rebuild its game state by replaying the logged moves (checking
   * the hash chain), and don't count the downtime against the player on turn or the reveal window. The shifted
   * clocks are saved right away, so a second restart doesn't take the downtime back.
   * `downSince` is when the referee was last known alive.
   * Returns 'resumed', 'archived' (already loaded from the archive: the record is a leftover), or false.
   */
  restoreRunning(rec: SavedMatch, downSince: number): 'resumed' | 'archived' | false {
    if (rec?.v !== 1 || !rec.match?.id) return false;
    if (this.matches.has(rec.match.id)) return 'archived';
    const m = { ...rec.match, events: [] } as Match;
    const downtime = Math.max(0, this.now() - Math.max(downSince, rec.savedAt));
    if (m.phase === 'reveal') {
      m.pausedMs = (m.pausedMs ?? 0) + downtime;
      // A charge that was in flight: its outcome is unknown, so re-check it from tick (never charge twice).
      if (m.league?.state === 'charging') m.league = { ...m.league, retryAt: this.now() };
    } else if (m.phase === 'active' || m.phase === 'ended') {
      try {
        const r = this.initialState(m);
        let state = r.state;
        const events = [...r.events];
        let head: Hex = ZERO32;
        for (const mv of m.moves) {
          const out = applyAction(state, mv.seat, mv.action);
          state = out.state;
          events.push(...out.events);
          head = nextHead(head, mv.seat, actionHash(mv.action)) as Hex;
          if (head !== mv.head) return false;
        }
        if (head !== m.head) return false;
        // A finished match kept here because archiving it failed. A forfeit (too many timeouts) ends without a move.
        if (m.phase === 'ended' && state.status !== 'ended') {
          const loser = m.clock.timeouts.findIndex((t) => t >= this.maxTimeouts);
          if (loser < 0) return false;
          const out = forfeit(state, loser as Seat);
          state = out.state;
          events.push(...out.events);
        }
        if ((state.status === 'ended') !== (m.phase === 'ended')) return false;
        m.state = state;
        m.events = events;
      } catch { return false; }
      if (m.phase === 'active') m.clock.turnStartedAt += downtime;
    } else return false;
    this.matches.set(m.id, m);
    if (m.phase === 'ended') this.changed(m); // archive it now; the running file goes once that worked
    else this.save(m);
    if (m.phase === 'reveal' && m.league?.state !== 'charging') this.maybeStart(m); // both revealed just before going down
    return 'resumed';
  }

  /** A running-match record that can't be resumed: refund its league entry fees if they were charged. */
  abandon(rec: SavedMatch) {
    // Only a match that never finished: a played one keeps its result (and its fees went where they should).
    const unplayed = rec?.match?.phase === 'reveal' || rec?.match?.phase === 'active';
    if (unplayed && rec.match.mode === 'league' && rec.match.league?.state !== 'failed') this.refundLeague(rec.match as Match);
  }

  private changed(m: Match) {
    if (m.cold) {
      try { this.full(m); } catch (e) { console.error(`could not reload match ${m.id} to save a change`, e); return; }
    }
    // onChange archives a finished match first; its running-match file is only dropped if that worked.
    const archived = this.onChange?.(m) !== false;
    if (m.phase === 'ended') m.archived = archived;
    this.save(m, !archived);
    this.bus?.match(m.id, { seq: m.moves.length, phase: m.phase });
    if (m.phase === 'ended' || m.phase === 'cancelled') this.bus?.lobby();
  }
}

function pickRandom(snap: MatchSnapshot): Action {
  const acts = snap.legalActions.filter((a) => a.type !== 'endTurn');
  if (!acts.length || Math.random() < 0.2) return { type: 'endTurn' };
  return acts[Math.floor(Math.random() * acts.length)];
}

/** League charges: how often "not started" must be read, LEAGUE_RECHECK_MS apart, before giving up. */
const LEAGUE_CHARGE_CHECKS = 3;
const LEAGUE_RECHECK_MS = 20_000;
const LEAGUE_WATCH_MS = 30 * 60_000;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** 10 characters, no look-alikes (0/O, 1/I/L): easy to read out or type. */
function challengeCode(): string {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
  const bytes = randomHex32().slice(2);
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[parseInt(bytes.slice(i * 2, i * 2 + 2), 16) % alphabet.length];
  return out;
}

/** The seats of an archived match, with everything needed to replay it. */
function archivedSeats(rec: ArchivedMatch): [Seatholder, Seatholder] {
  return rec.log.players.map((p, i) => ({
    address: p.address, race: p.race, deck: p.deck, deckId: p.deckId, agent: p.agent,
    seedCommit: p.seedCommit, seedShare: p.seedShare, deckSalt: p.deckSalt, delegations: p.delegations,
    resultSig: rec.resultSigs[i] ?? undefined, bot: rec.bots[i] ?? undefined,
  })) as [Seatholder, Seatholder];
}
