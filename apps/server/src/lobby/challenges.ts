import { randomHex32, RACES, type Equipped, type Race, type Seat } from '@forkfall/engine';
import type { Mode } from '@forkfall/sdk';
import type { Address, Hex } from 'viem';
import type { LiveBus } from '../live.ts';
import { ApiError, same, type Challenge, type ChallengeView, type Match, type Seatholder } from './types.ts';

export const CHALLENGE_TTL_MS = 24 * 3600_000;
export const MAX_OPEN_CHALLENGES = 5;
/** Open challenges addressed to one wallet, from everyone (keeps a target's incoming list from being flooded). */
export const MAX_INCOMING_CHALLENGES = 20;
/** A challenge match waits this long for both players to join (the challenger may be in another tab). */
export const CHALLENGE_REVEAL_MS = 3 * 60_000;
/** Answered or expired challenges are forgotten after this. */
const CHALLENGE_KEEP_MS = 3600_000;

/** What friend challenges need from the lobby around them. */
export interface ChallengesHost {
  now: () => number;
  matches: Map<Hex, Match>;
  /** Set by the API after the lobby is built, so read it when needed. */
  bus: () => LiveBus | undefined;
  profiles?: { equipped(address: string): Equipped };
  seatOf(m: Match, address: Address | null): Seat | null;
  checkEligibility(address: Address, mode: Mode, declaredAgent: boolean): Promise<boolean>;
  resolveDeck(address: Address, mode: Mode, race: Race, deck?: number[], deckId?: Hex): Promise<{ deck: number[]; deckId: Hex }>;
  newMatch(mode: Mode, season: number, players: [Seatholder, Seatholder]): Match;
}

/** Friend challenges (casual): links anyone, or one address, can accept; rematches are challenges too. */
export class Challenges {
  private challenges = new Map<string, Challenge>();

  constructor(private host: ChallengesHost) {}

  /** Create a challenge link. Casual only: ranked between friends would invite win trading. */
  async create(address: Address, body: { race: Race; deck?: number[]; deckId?: Hex; seedCommit: Hex; to?: string; rematchOf?: Hex }, agent: boolean) {
    const h = this.host;
    if (!/^0x[0-9a-fA-F]{64}$/.test(body.seedCommit ?? '')) throw new ApiError(400, 'seedCommit (bytes32) required');
    if (!RACES.includes(body.race)) throw new ApiError(400, 'unknown race');
    let to: Address | undefined;
    if (body.to !== undefined && body.to !== null && body.to !== '') {
      if (!/^0x[0-9a-fA-F]{40}$/.test(body.to)) throw new ApiError(400, 'to must be an address');
      to = body.to.toLowerCase() as Address;
      if (to === address.toLowerCase()) throw new ApiError(400, 'you can’t challenge yourself');
    }
    if (body.rematchOf) {
      const prev = h.matches.get(body.rematchOf);
      if (!prev || prev.phase !== 'ended') throw new ApiError(400, 'rematch: no such finished match');
      const me = h.seatOf(prev, address);
      if (me === null) throw new ApiError(403, 'rematch: you didn’t play that match');
      const opp = prev.players[me === 0 ? 1 : 0];
      if (opp.bot) throw new ApiError(400, 'rematch the house bot from Play instead');
      to = opp.address.toLowerCase() as Address;
    }
    this.prune();
    const live = [...this.challenges.values()].filter((c) => c.state === 'open' && h.now() <= c.expiresAt);
    if (live.filter((c) => same(c.from.address, address)).length >= MAX_OPEN_CHALLENGES) {
      throw new ApiError(429, `at most ${MAX_OPEN_CHALLENGES} open challenges: cancel one first`);
    }
    if (to && live.filter((c) => c.to && same(c.to, to!)).length >= MAX_INCOMING_CHALLENGES) {
      throw new ApiError(429, 'that player has too many pending challenges right now');
    }
    const isAgent = await h.checkEligibility(address, 'casual', agent);
    const { deck, deckId } = await h.resolveDeck(address, 'casual', body.race, body.deck, body.deckId);
    const code = challengeCode();
    const c: Challenge = {
      code, from: { address, race: body.race, deck, deckId, agent: isAgent, seedCommit: body.seedCommit },
      to, rematchOf: body.rematchOf, createdAt: h.now(), expiresAt: h.now() + CHALLENGE_TTL_MS, state: 'open',
    };
    this.challenges.set(code, c);
    if (to) h.bus()?.user(to, 'challenge', { code });
    return this.view(c, address);
  }

  get(code: string): Challenge {
    const c = this.challenges.get(code);
    if (!c) throw new ApiError(404, 'no such challenge (it may have expired)');
    return c;
  }

  view(c: Challenge, viewer: Address | null): ChallengeView {
    const h = this.host;
    const expired = c.state === 'open' && h.now() > c.expiresAt;
    const player = viewer && (same(c.from.address, viewer) || (c.matchId && h.matches.get(c.matchId)?.players.some((p) => same(p.address, viewer))));
    return {
      code: c.code,
      from: { address: c.from.address, agent: c.from.agent, ...(h.profiles ? { cosmetics: h.profiles.equipped(c.from.address) } : {}) },
      to: c.to ?? null, rematchOf: c.rematchOf ?? null,
      state: expired ? 'expired' : c.state, createdAt: c.createdAt, expiresAt: c.expiresAt,
      ...(player && c.matchId ? { matchId: c.matchId, matchPhase: h.matches.get(c.matchId)?.phase } : {}),
    };
  }

  /** Accept: the match starts right away (both reveal as usual). */
  async accept(address: Address, code: string, body: { race: Race; deck?: number[]; deckId?: Hex; seedCommit: Hex }, agent: boolean) {
    const h = this.host;
    const c = this.get(code);
    if (c.state !== 'open') throw new ApiError(409, `this challenge was already ${c.state}`);
    if (h.now() > c.expiresAt) throw new ApiError(410, 'this challenge has expired');
    if (same(c.from.address, address)) throw new ApiError(400, 'you can’t accept your own challenge');
    if (c.to && !same(c.to, address)) throw new ApiError(403, 'this challenge is for someone else');
    if (!/^0x[0-9a-fA-F]{64}$/.test(body.seedCommit ?? '')) throw new ApiError(400, 'seedCommit (bytes32) required');
    if (!RACES.includes(body.race)) throw new ApiError(400, 'unknown race');
    const isAgent = await h.checkEligibility(address, 'casual', agent);
    const { deck, deckId } = await h.resolveDeck(address, 'casual', body.race, body.deck, body.deckId);
    if (c.state !== 'open') throw new ApiError(409, `this challenge was already ${c.state}`); // raced while we awaited
    if (h.now() > c.expiresAt) throw new ApiError(410, 'this challenge has expired');
    // A copy of the challenger's seat: if this match is cancelled before it starts, the link reopens untouched.
    const m = h.newMatch('casual', 0, [{ ...c.from }, { address, race: body.race, deck, deckId, agent: isAgent, seedCommit: body.seedCommit }]);
    m.challenge = c.code;
    c.state = 'accepted';
    c.matchId = m.id;
    c.closedAt = h.now();
    h.bus()?.user(c.from.address, 'challenge', { code: c.code, matchId: m.id });
    return { matchId: m.id, challenge: this.view(c, address) };
  }

  /** The challenger cancels, or the addressee declines. */
  close(address: Address, code: string) {
    const c = this.get(code);
    if (c.state !== 'open') throw new ApiError(409, `this challenge was already ${c.state}`);
    if (same(c.from.address, address)) c.state = 'cancelled';
    else if (c.to && same(c.to, address)) c.state = 'declined';
    else throw new ApiError(403, 'only the challenger can cancel, or the challenged player decline');
    c.closedAt = this.host.now();
    const other = c.state === 'cancelled' ? c.to : c.from.address;
    if (other) this.host.bus()?.user(other, 'challenge', { code: c.code });
    return this.view(c, address);
  }

  /** Your open and recent challenges, and open ones addressed to you. */
  forPlayer(address: Address) {
    this.prune();
    const all = [...this.challenges.values()].sort((a, b) => b.createdAt - a.createdAt);
    return {
      outgoing: all.filter((c) => same(c.from.address, address)).map((c) => this.view(c, address)),
      incoming: all.filter((c) => c.to && same(c.to, address) && c.state === 'open' && this.host.now() <= c.expiresAt)
        .slice(0, MAX_INCOMING_CHALLENGES).map((c) => this.view(c, address)),
    };
  }

  /** Forget challenges an hour after they expired or were answered (an accepted one once its match is under way). */
  prune() {
    const cutoff = this.host.now() - CHALLENGE_KEEP_MS;
    for (const [k, c] of this.challenges) {
      const waiting = c.matchId && this.host.matches.get(c.matchId)?.phase === 'reveal';
      if (!waiting && ((c.closedAt ?? Infinity) < cutoff || c.expiresAt < cutoff)) this.challenges.delete(k);
    }
  }

  /** A challenge match cancelled before it started (someone never joined): reopen the link while it's valid. */
  reopen(m: Match) {
    const c = m.challenge ? this.challenges.get(m.challenge) : undefined;
    if (!c || c.matchId !== m.id || c.state !== 'accepted') return;
    c.matchId = undefined;
    c.closedAt = undefined;
    c.state = this.host.now() <= c.expiresAt ? 'open' : 'cancelled';
    this.host.bus()?.user(c.from.address, 'challenge', { code: c.code });
  }

  save(): Challenge[] { return [...this.challenges.values()]; }

  restore(list: Challenge[] | undefined) {
    this.challenges = new Map((list ?? []).map((c) => [c.code, c]));
  }
}

/** 10 characters, no look-alikes (0/O, 1/I/L): easy to read out or type. */
function challengeCode(): string {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
  const bytes = randomHex32().slice(2);
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[parseInt(bytes.slice(i * 2, i * 2 + 2), 16) % alphabet.length];
  return out;
}
