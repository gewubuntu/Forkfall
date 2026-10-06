import type { Action, Equipped, GameEvent, GameState, Race, Seat } from '@forkfall/engine';
import type { Delegation, MatchLog, MatchResult, Mode } from '@forkfall/sdk';
import type { Address, Hex, LocalAccount } from 'viem';
import type { Chain, LeagueOps, RefereeSettler } from '../chain.ts';
import type { StateStore } from '../state.ts';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type BotKind = 'greedy' | 'random';

export interface Seatholder {
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

export interface LoggedMove {
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
  /** Card rules version, set when the match starts (absent: saved before versions were recorded, or not started). */
  rules?: number;
  /** Sealed: played with Sealed decks, so the one-race rule is lifted (see ./sealed.ts). */
  format?: 'sealed';
  /** Sealed: the run each seat plays for (null: the house bot). */
  sealed?: [string | null, string | null];
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
    /** When the referee cancelled the charged match on-chain because its result could never land (fees refunded). */
    refundedAt?: number;
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
  /** A charged league match still unsettled this long after it ended is cancelled and refunded (default 6 h). */
  leagueSettleTimeoutMs?: number;
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

export interface QueueEntry {
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

export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The seats of an archived match, with everything needed to replay it. */
export function archivedSeats(rec: ArchivedMatch): [Seatholder, Seatholder] {
  return rec.log.players.map((p, i) => ({
    address: p.address, race: p.race, deck: p.deck, deckId: p.deckId, agent: p.agent,
    seedCommit: p.seedCommit, seedShare: p.seedShare, deckSalt: p.deckSalt, delegations: p.delegations,
    resultSig: rec.resultSigs[i] ?? undefined, bot: rec.bots[i] ?? undefined,
  })) as [Seatholder, Seatholder];
}
