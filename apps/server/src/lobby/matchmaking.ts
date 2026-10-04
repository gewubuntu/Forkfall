import { keccakHex, randomHex32, type Race } from '@forkfall/engine';
import { eloUpdate, MODES, START_RATING, ZERO_ADDRESS, type Mode } from '@forkfall/sdk';
import type { Address, Hex } from 'viem';
import { ApiError, same, type LobbyOptions, type Match, type QueueEntry, type SavedLobby, type Seatholder } from './types.ts';

/**
 * Rated queues pair players whose ratings are close: within ±100 at first, 50 wider every 10 s of waiting, and
 * anyone in the queue after a minute, so a thin queue never leaves someone waiting for a perfect match.
 */
export const RATING_WINDOW = { start: 100, step: 50, everyMs: 10_000, anyoneAfterMs: 60_000 } as const;
export function ratingWindow(waitedMs: number): number {
  if (waitedMs >= RATING_WINDOW.anyoneAfterMs) return Infinity;
  return RATING_WINDOW.start + RATING_WINDOW.step * Math.floor(Math.max(0, waitedMs) / RATING_WINDOW.everyMs);
}

/** What the queue needs from the lobby around it. */
export interface MatchmakingHost {
  opts: LobbyOptions;
  now: () => number;
  queueTtlMs: number;
  matches: Map<Hex, Match>;
  checkEligibility(address: Address, mode: Mode, declaredAgent: boolean): Promise<boolean>;
  resolveDeck(address: Address, mode: Mode, race: Race, deck?: number[], deckId?: Hex): Promise<{ deck: number[]; deckId: Hex }>;
  leagueEntry(address: Address): Promise<Address>;
  newMatch(mode: Mode, season: number, players: [Seatholder, Seatholder]): Match;
}

/** The matchmaking queue: tickets, ratings, and pairing within a rating window that widens while players wait. */
export class Matchmaker {
  private queue: QueueEntry[] = [];
  private matchedTickets = new Map<string, Hex>();
  private byAddressTicket = new Map<Address, string>();
  /** Bumped by every leave (and so every enqueue): an enqueue still awaiting the chain knows it was superseded. */
  private queueGen = new Map<string, number>();
  private sweeping = false;

  constructor(private host: MatchmakingHost) {}

  async enqueue(address: Address, body: { mode: Mode; race: Race; deck?: number[]; deckId?: Hex; seedCommit: Hex }, agent: boolean) {
    const h = this.host;
    if (!(body.mode in MODES)) throw new ApiError(400, 'unknown mode');
    if (!/^0x[0-9a-fA-F]{64}$/.test(body.seedCommit ?? '')) throw new ApiError(400, 'seedCommit (bytes32) required');
    this.leaveQueue(address);
    const gen = this.queueGen.get(address.toLowerCase());
    const isAgent = await h.checkEligibility(address, body.mode, agent);
    const { deck, deckId } = await h.resolveDeck(address, body.mode, body.race, body.deck, body.deckId);
    const operator = body.mode === 'league' ? await h.leagueEntry(address) : undefined;
    const season = await this.seasonFor(body.mode);
    const rating = body.mode === 'casual' ? undefined : await this.ratingOf(address, body.mode, season);
    // While we awaited the chain, the player left the queue or queued again: that request wins, this one stops here
    // (otherwise a cancelled request could still pair them, or two requests put them in two matches).
    if (this.queueGen.get(address.toLowerCase()) !== gen) throw new ApiError(409, 'queue request cancelled by a newer one');
    const ticket = keccakHex(address, String(h.now()), randomHex32());
    const me: QueueEntry = { ticket, address, mode: body.mode, race: body.race, deck, deckId, agent: isAgent, seedCommit: body.seedCommit, at: h.now(), seen: h.now(), operator, rating };
    this.byAddressTicket.set(address, ticket);
    this.prune();
    const idx = this.opponentFor(me, h.now());
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
    const { opts } = this.host;
    if (mode === 'casual') return 0;
    if (mode !== 'league') return opts.chain.season();
    if (!opts.league) throw new ApiError(503, 'the Agent League is not enabled on this referee');
    return opts.league.currentWeek();
  }

  /**
   * A rated player's rating for pairing. Ranked and the Human queue share the season's on-chain Elo; off-chain the
   * referee replays the same Elo over the rated matches it refereed. League agents use their weekly standing.
   */
  private async ratingOf(address: Address, mode: Mode, season: number): Promise<number> {
    const { opts } = this.host;
    if (mode === 'league') {
      try { return (await opts.league?.rating?.(season, address)) ?? START_RATING; } catch { return START_RATING; }
    }
    try {
      const onChain = await opts.chain.rating(season, address);
      if (onChain !== null) return onChain;
    } catch (e) { console.error(`could not read the rating of ${address}; estimating it from refereed matches`, e); }
    return this.localRating(season, address);
  }

  /** The season's Elo as MatchSettlement computes it, replayed over the ranked and Human queue matches refereed here. */
  localRating(season: number, address: Address): number {
    const ended = [...this.host.matches.values()]
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
    const m = this.host.newMatch(first.mode, season, [seatFrom(first), seatFrom(second)]);
    this.matchedTickets.set(first.ticket, m.id);
    this.matchedTickets.set(second.ticket, m.id);
    return m;
  }

  /**
   * Pair waiting players whose rating windows have widened enough to meet (an arrival pairs at once if it can;
   * this catches the ones who waited). Runs every tick; the oldest waiter picks first.
   */
  async matchQueue(): Promise<void> {
    if (this.sweeping) return;
    this.prune();
    const due = this.host.now();
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
      this.prune();
      const now = this.host.now();
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

  queueStatus(address: Address) {
    const ticket = this.byAddressTicket.get(address);
    if (!ticket) return { status: 'idle' as const };
    const matchId = this.matchedTickets.get(ticket);
    if (matchId) return { status: 'matched' as const, ticket, matchId };
    const entry = this.queue.find((q) => q.ticket === ticket);
    if (!entry) return { status: 'idle' as const };
    entry.seen = this.host.now();
    return { status: 'queued' as const, ticket };
  }

  /** Drop queue entries whose client stopped polling, so nobody gets matched with a ghost. */
  prune() {
    const cutoff = this.host.now() - this.host.queueTtlMs;
    this.queue = this.queue.filter((q) => q.seen >= cutoff);
  }

  leaveQueue(address: Address) {
    const key = address.toLowerCase();
    this.queueGen.set(key, (this.queueGen.get(key) ?? 0) + 1);
    this.queue = this.queue.filter((q) => q.address !== address);
  }

  /** A ticket answers "matched" while its match runs; once that match is over (or gone), forget it. */
  pruneTickets() {
    for (const [t, id] of this.matchedTickets) {
      const phase = this.host.matches.get(id)?.phase;
      if (phase !== 'reveal' && phase !== 'active') this.matchedTickets.delete(t);
    }
    const live = new Set([...this.queue.map((q) => q.ticket), ...this.matchedTickets.keys()]);
    for (const [a, t] of this.byAddressTicket) if (!live.has(t)) this.byAddressTicket.delete(a);
  }

  /** The queue and tickets, for `restore`. */
  save(): Pick<SavedLobby, 'queue' | 'matchedTickets' | 'byAddressTicket'> {
    return { queue: this.queue, matchedTickets: [...this.matchedTickets], byAddressTicket: [...this.byAddressTicket] };
  }

  restore(rec: SavedLobby) {
    const now = this.host.now();
    this.queue = rec.queue ?? [];
    this.matchedTickets = new Map(rec.matchedTickets ?? []);
    this.byAddressTicket = new Map(rec.byAddressTicket ?? []);
    // Queued clients keep polling through a restart; give them the TTL again rather than dropping them at once.
    // Downtime isn't waiting either: rating windows pick up where they were.
    const down = rec.aliveAt ? Math.max(0, now - rec.aliveAt) : 0;
    for (const q of this.queue) { q.seen = now; q.at += down; }
  }
}

function seatFrom(q: QueueEntry): Seatholder {
  return { address: q.address, race: q.race, deck: q.deck, deckId: q.deckId, agent: q.agent, seedCommit: q.seedCommit };
}
