import {
  applyAction, combineSeeds, createMatch, eventsFor, forfeit, keccakHex, legalActions, randomHex32,
  RACES, starterDeck, validateDeck, viewFor,
  type Action, type GameEvent, type GameState, type Race, type Seat,
} from '@forkfall/engine';
import {
  actionHash, commitSeed, MODES, MOVE_TYPES, RESULT_TYPES, moveDigest, nextHead, resultDigest, viewGreedy, ZERO32, ZERO_ADDRESS,
  type Delegation, type MatchResult, type MatchSnapshot, type Mode,
} from '@forkfall/sdk';
import { recoverAddress, type Address, type Hex, type LocalAccount, type TypedDataDomain } from 'viem';
import type { Chain } from './chain.ts';

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
}

export interface LobbyOptions {
  chain: Chain;
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
  private houseSecrets = new Map<string, { seedShare: Hex; deckSalt: Hex }>();
  readonly turnMs: number;
  readonly bankMs: number;
  readonly revealMs: number;
  readonly graceMs: number;
  readonly maxTimeouts: number;
  readonly queueTtlMs: number;
  readonly now: () => number;
  readonly domain: TypedDataDomain;
  onChange?: (m: Match) => void;

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
    if (mode === 'human') {
      if (agent) throw new ApiError(403, 'agents cannot join the Human queue');
      if (this.opts.chain.online && !(await this.opts.chain.isHuman(address))) {
        throw new ApiError(403, 'Human queue requires a proof-of-personhood attestation in HumanRegistry');
      }
    }
    return agent;
  }

  // ─── Queue ────────────────────────────────────────────────────
  async enqueue(address: Address, body: { mode: Mode; race: Race; deck?: number[]; deckId?: Hex; seedCommit: Hex }, agent: boolean) {
    if (!(body.mode in MODES)) throw new ApiError(400, 'unknown mode');
    if (!/^0x[0-9a-fA-F]{64}$/.test(body.seedCommit ?? '')) throw new ApiError(400, 'seedCommit (bytes32) required');
    this.leaveQueue(address);
    const isAgent = await this.checkEligibility(address, body.mode, agent);
    const { deck, deckId } = await this.resolveDeck(address, body.mode, body.race, body.deck, body.deckId);
    const ticket = keccakHex(address, String(this.now()), randomHex32());
    const me: QueueEntry = { ticket, address, mode: body.mode, race: body.race, deck, deckId, agent: isAgent, seedCommit: body.seedCommit, at: this.now(), seen: this.now() };
    this.byAddressTicket.set(address, ticket);
    this.pruneQueue();
    const idx = this.queue.findIndex((q) => q.mode === me.mode && q.address !== address);
    if (idx < 0) {
      this.queue.push(me);
      return { status: 'queued' as const, ticket };
    }
    const [opp] = this.queue.splice(idx, 1);
    const season = await this.opts.chain.season();
    const m = this.newMatch(me.mode, season, [this.seatFrom(opp), this.seatFrom(me)]);
    this.matchedTickets.set(opp.ticket, m.id);
    this.matchedTickets.set(ticket, m.id);
    return { status: 'matched' as const, ticket, matchId: m.id };
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

  leaveQueue(address: Address) {
    this.queue = this.queue.filter((q) => q.address !== address);
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
    this.maybeStart(m);
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
    this.maybeStart(m);
    return { ok: true, phase: m.phase };
  }

  private maybeStart(m: Match) {
    if (m.phase !== 'reveal' || !m.players.every((p) => p.seedShare && p.deckSalt)) return;
    const [a, b] = m.players;
    const seed = combineSeeds(m.id, a.seedShare!, b.seedShare!);
    const r = createMatch({
      matchId: m.id, seed,
      players: [
        { address: a.address, race: a.race, deck: a.deck, deckSalt: a.deckSalt! },
        { address: b.address, race: b.race, deck: b.deck, deckSalt: b.deckSalt! },
      ],
    });
    m.state = r.state;
    m.events.push(...r.events);
    m.phase = 'active';
    m.clock.turnStartedAt = this.now();
    this.changed(m);
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
    for (const m of this.matches.values()) {
      if (m.phase === 'reveal' && now - m.createdAt > this.revealMs) { m.phase = 'cancelled'; this.changed(m); continue; }
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
      if (m.phase === 'ended') { await this.houseSignResult(m); continue; }
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
    const m = this.get(matchId);
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
    const graceOver = this.now() - (m.endedAt ?? 0) > this.graceMs || m.state?.endReason === 'timeout' || m.state?.endReason === 'concede';
    if (winnerSeat !== null && m.players[winnerSeat].resultSig && graceOver) {
      return { ...base, byReferee: true, winnerSig: m.players[winnerSeat].resultSig, note: 'submit with the REFEREE key' };
    }
    throw new ApiError(409, 'waiting for result signatures');
  }

  log(matchId: Hex) {
    const m = this.get(matchId);
    if (m.phase !== 'ended') throw new ApiError(409, 'full log (with seed reveals) is public after the match ends');
    return {
      matchId: m.id, mode: m.mode, domain: this.domain,
      players: m.players.map((p) => ({ address: p.address, race: p.race, deck: p.deck, deckId: p.deckId, agent: p.agent, seedCommit: p.seedCommit, seedShare: p.seedShare, deckSalt: p.deckSalt, delegations: p.delegations ?? [] })),
      moves: m.moves, head: m.head, result: m.result,
    };
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
    const seat = this.seatOf(m, address);
    const s = m.state;
    return {
      matchId: m.id,
      phase: m.phase,
      mode: m.mode,
      seat,
      players: m.players.map((p) => ({ address: p.address, race: p.race, agent: p.agent })),
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
    };
  }

  eventsSince(m: Match, address: Address | null, since: number) {
    const seat = this.seatOf(m, address);
    const slice = m.events.slice(since);
    return { events: eventsFor(slice, seat), next: m.events.length };
  }

  list() {
    return [...this.matches.values()]
      .filter((m) => m.phase !== 'cancelled')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50)
      .map((m) => ({
        matchId: m.id, mode: m.mode, phase: m.phase, turn: m.state?.turn ?? 0,
        players: m.players.map((p) => ({ address: p.address, race: p.race, agent: p.agent })),
        winner: m.result?.winner,
      }));
  }

  leaderboard() {
    const rows = new Map<string, { address: string; agent: boolean; wins: number; losses: number; draws: number }>();
    for (const m of this.matches.values()) {
      if (m.phase !== 'ended' || !m.result || m.mode === 'casual') continue;
      for (const p of m.players) {
        const r = rows.get(p.address) ?? { address: p.address, agent: p.agent, wins: 0, losses: 0, draws: 0 };
        if (m.result.winner === ZERO_ADDRESS) r.draws++; else if (m.result.winner === p.address) r.wins++; else r.losses++;
        rows.set(p.address, r);
      }
    }
    return { rows: [...rows.values()].sort((a, b) => b.wins - a.wins || a.losses - b.losses) };
  }

  private changed(m: Match) { this.onChange?.(m); }
}

function pickRandom(snap: MatchSnapshot): Action {
  const acts = snap.legalActions.filter((a) => a.type !== 'endTurn');
  if (!acts.length || Math.random() < 0.2) return { type: 'endTurn' };
  return acts[Math.floor(Math.random() * acts.length)];
}
