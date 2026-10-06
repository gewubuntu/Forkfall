import {
  applyAction, combineSeeds, createMatch, eventsFor, forfeit, keccakHex, legalActions, randomHex32,
  RACES, RULES_VERSION, rulesCandidates, starterDeck, validateDeck, viewFor,
  type Action, type Race, type Seat,
} from '@forkfall/engine';
import {
  actionHash, commitSeed, MODES, MOVE_TYPES, RESULT_TYPES, moveDigest, nextHead, replayLog, resultDigest, viewGreedy, ZERO32, ZERO_ADDRESS,
  type Delegation, type MatchLog, type MatchSnapshot, type MatchSummary, type Mode,
} from '@forkfall/sdk';
import { recoverAddress, type Address, type Hex, type TypedDataDomain } from 'viem';
import { CHALLENGE_REVEAL_MS, Challenges } from './lobby/challenges.ts';
import { LeagueCharges } from './lobby/league.ts';
import { Matchmaker } from './lobby/matchmaking.ts';
import {
  ApiError, archivedSeats,
  type ArchivedMatch, type ArchiveSummary, type BotKind, type Challenge, type LobbyOptions, type Match, type SavedLobby,
  type SavedMatch, type Seatholder,
} from './lobby/types.ts';
import type { LiveBus } from './live.ts';

// The lobby's parts live in ./lobby/; everything is re-exported here, so importers keep using './lobby.ts'.
export * from './lobby/types.ts';
export { RATING_WINDOW, ratingWindow } from './lobby/matchmaking.ts';
export { CHALLENGE_REVEAL_MS, CHALLENGE_TTL_MS, MAX_INCOMING_CHALLENGES, MAX_OPEN_CHALLENGES } from './lobby/challenges.ts';

/**
 * The referee. Runs the one rules engine, verifies each EIP-712-signed move against the
 * log hash chain, enforces the shared 45s + 60s-bank timer, and assembles the settlement.
 * Matchmaking, friend challenges and League charges are its parts in ./lobby/; it owns the matches.
 */
export class Lobby {
  readonly matches = new Map<Hex, Match>();
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
  /** Live notices to connected clients (set by the API); everything works without it, just by polling. */
  bus?: LiveBus;
  private readonly queue: Matchmaker;
  private readonly challenges: Challenges;
  private readonly league: LeagueCharges;

  constructor(readonly opts: LobbyOptions) {
    this.turnMs = (opts.turnSeconds ?? 45) * 1000;
    this.bankMs = (opts.bankSeconds ?? 60) * 1000;
    this.revealMs = (opts.revealSeconds ?? 60) * 1000;
    this.graceMs = (opts.resultGraceSeconds ?? 600) * 1000;
    this.maxTimeouts = opts.maxTimeouts ?? 3;
    this.queueTtlMs = (opts.queueTtlSeconds ?? 30) * 1000;
    this.now = opts.now ?? Date.now;
    this.domain = { name: 'Forkfall', version: '1', chainId: opts.chain.chainId, verifyingContract: opts.chain.settlement };
    const checkEligibility = (a: Address, mode: Mode, agent: boolean) => this.checkEligibility(a, mode, agent);
    const resolveDeck = (a: Address, mode: Mode, race: Race, deck?: number[], deckId?: Hex) => this.resolveDeck(a, mode, race, deck, deckId);
    const newMatch = (mode: Mode, season: number, players: [Seatholder, Seatholder]) => this.newMatch(mode, season, players);
    this.league = new LeagueCharges({
      opts, now: this.now, save: (m) => this.save(m), maybeStart: (m) => this.maybeStart(m), changed: (m) => this.changed(m),
    });
    this.queue = new Matchmaker({
      opts, now: this.now, queueTtlMs: this.queueTtlMs, matches: this.matches,
      checkEligibility, resolveDeck, newMatch, leagueEntry: (a) => this.league.entry(a),
    });
    this.challenges = new Challenges({
      now: this.now, matches: this.matches, bus: () => this.bus, profiles: () => this.opts.profiles,
      seatOf: (m, a) => this.seatOf(m, a), checkEligibility, resolveDeck, newMatch,
    });
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

  // ─── Queue (./lobby/matchmaking.ts) ───────────────────────────
  enqueue(address: Address, body: { mode: Mode; race: Race; deck?: number[]; deckId?: Hex; seedCommit: Hex }, agent: boolean) {
    return this.queue.enqueue(address, body, agent);
  }
  queueStatus(address: Address) { return this.queue.queueStatus(address); }
  leaveQueue(address: Address) { this.queue.leaveQueue(address); }
  /** Pair waiting players whose rating windows now meet (runs every tick). */
  matchQueue() { return this.queue.matchQueue(); }
  /** The season's Elo replayed over the rated matches refereed here (the off-chain rating estimate). */
  localRating(season: number, address: Address) { return this.queue.localRating(season, address); }

  // ─── Friend challenges (./lobby/challenges.ts) ────────────────
  createChallenge(address: Address, body: { race: Race; deck?: number[]; deckId?: Hex; seedCommit: Hex; to?: string; rematchOf?: Hex }, agent: boolean) {
    return this.challenges.create(address, body, agent);
  }
  challenge(code: string): Challenge { return this.challenges.get(code); }
  challengeView(c: Challenge, viewer: Address | null) { return this.challenges.view(c, viewer); }
  acceptChallenge(address: Address, code: string, body: { race: Race; deck?: number[]; deckId?: Hex; seedCommit: Hex }, agent: boolean) {
    return this.challenges.accept(address, code, body, agent);
  }
  closeChallenge(address: Address, code: string) { return this.challenges.close(address, code); }
  challengesFor(address: Address) { return this.challenges.forPlayer(address); }

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

  /** A casual match between two Sealed decks (a seat may be the house bot), tagged with each seat's Sealed run. */
  sealedMatch(players: [Seatholder, Seatholder], runs: [string | null, string | null]): Match {
    return this.newMatch('casual', 0, players, { format: 'sealed', sealed: runs });
  }

  /** Whether this wallet may play (banned wallets can't; agents are flagged). Used by Sealed. */
  eligibleFor(address: Address, declaredAgent: boolean) { return this.checkEligibility(address, 'casual', declaredAgent); }

  private newMatch(mode: Mode, season: number, players: [Seatholder, Seatholder], extra: Pick<Match, 'format' | 'sealed'> = {}): Match {
    const id = keccakHex('forkfall-match', randomHex32(), String(this.now())) as Hex;
    const m: Match = {
      id, mode, season: mode === 'casual' ? 0 : season, createdAt: this.now(), phase: 'reveal', players,
      events: [], moves: [], head: ZERO32, clock: { turnStartedAt: 0, bank: [this.bankMs, this.bankMs], timeouts: [0, 0] },
      ...extra,
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
      this.league.charge(m);
      return;
    }
    m.rules ??= RULES_VERSION; // played, and replayed forever, under the rules of the day it starts
    const r = this.initialState(m);
    m.state = r.state;
    m.events.push(...r.events);
    m.phase = 'active';
    m.clock.turnStartedAt = this.now();
    this.changed(m);
  }

  private initialState(m: Match, rules = m.rules ?? RULES_VERSION) {
    const [a, b] = m.players;
    return createMatch({
      rules,
      ...(m.format ? { format: m.format } : {}),
      matchId: m.id, seed: combineSeeds(m.id, a.seedShare!, b.seedShare!),
      players: [
        { address: a.address, race: a.race, deck: a.deck, deckSalt: a.deckSalt! },
        { address: b.address, race: b.race, deck: b.deck, deckSalt: b.deckSalt! },
      ],
    });
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
    // The board may have moved on while the signature was checked (the house bot played, a turn timed out): a move
    // signed for the older position must not land on top of the new one, or the log's hash chain breaks.
    if (m.phase !== 'active') throw new ApiError(409, `match is ${m.phase}`);
    if (seq !== m.moves.length) throw new ApiError(409, `stale seq: expected ${m.moves.length}`);
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
    this.queue.prune();
    this.matchQueue().catch((e) => console.error('queue matching failed', e));
    this.challenges.prune();
    this.queue.pruneTickets();
    this.unloadIdle(now);
    for (const m of this.matches.values()) {
      if (this.league.tick(m, now)) continue;
      const revealWindow = m.challenge ? CHALLENGE_REVEAL_MS : this.revealMs;
      if (m.phase === 'reveal' && now - m.createdAt - (m.pausedMs ?? 0) > revealWindow && m.league?.state !== 'charging') {
        m.phase = 'cancelled'; this.challenges.reopen(m); this.changed(m);
        if (m.league?.state === 'charged') this.league.refund(m);
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
      const seq = m.moves.length;
      const sig = await this.opts.house.signTypedData({
        domain: this.domain, types: MOVE_TYPES, primaryType: 'Move',
        message: { matchId: m.id, seq, prevHash: m.head, actionHash: actionHash(action) },
      });
      // The player may have moved while this was signed (a concede is legal in the bot's turn): try again next step.
      if (m.phase !== 'active' || m.moves.length !== seq) continue;
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
      rules: m.rules, ...(m.format ? { format: m.format } : {}), domain: { ...this.domain, chainId: Number(this.domain.chainId) },
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
      phase: 'ended', players, rules: replay.rules, ...(log.format ? { format: log.format } : {}), state: replay.final, events: replay.frames.flatMap((f) => f.events),
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
      phase: 'ended', rules: log.rules, ...(log.format ? { format: log.format } : {}), events: [], moves: [], head: log.head,
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
    m.rules = replay.rules;
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
        if (m.mode === 'league' && /ResultsClosed/.test(error)) {
          // Its week's payouts are already published: the result can never land, so refund both entry fees.
          m.referee = { state: 'failed', attempts: maxAttempts, error };
          this.league.refund(m);
        } else {
          m.referee = { state: 'failed', attempts, error, retryAt: attempts < maxAttempts ? this.now() + 60_000 * attempts : undefined };
        }
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
  /** Whether this wallet has a match here (running or finished; a match cancelled before it started doesn't count). */
  hasPlayed(address: Address): boolean {
    for (const m of this.matches.values()) if (m.phase !== 'cancelled' && this.seatOf(m, address) !== null) return true;
    return false;
  }

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
    return { v: 1, aliveAt: this.now(), ...this.queue.save(), challenges: this.challenges.save() };
  }

  restoreLobby(rec: SavedLobby) {
    if (rec?.v !== 1) return;
    this.queue.restore(rec);
    this.challenges.restore(rec.challenges);
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
      // Saved before matches recorded their rules version: the first version that replays the moves, by date.
      const versions = m.rules !== undefined ? [m.rules] : rulesCandidates(m.createdAt);
      let rebuilt: ReturnType<Lobby['rebuild']> = null;
      for (const v of versions) if ((rebuilt = this.rebuild(m, v))) break;
      if (!rebuilt) return false;
      Object.assign(m, rebuilt);
      if (m.phase === 'active') m.clock.turnStartedAt += downtime;
    } else return false;
    this.matches.set(m.id, m);
    if (m.phase === 'ended') this.changed(m); // archive it now; the running file goes once that worked
    else this.save(m);
    if (m.phase === 'reveal' && m.league?.state !== 'charging') this.maybeStart(m); // both revealed just before going down
    return 'resumed';
  }

  /**
   * Replay a saved match's moves under a rules version, checking the hash chain. Null if they don't replay to the
   * saved head and phase.
   */
  private rebuild(m: Match, rules: number): Pick<Match, 'rules' | 'state' | 'events'> | null {
    try {
      const r = this.initialState(m, rules);
      let state = r.state;
      const events = [...r.events];
      let head: Hex = ZERO32;
      for (const mv of m.moves) {
        const out = applyAction(state, mv.seat, mv.action);
        state = out.state;
        events.push(...out.events);
        head = nextHead(head, mv.seat, actionHash(mv.action)) as Hex;
        if (head !== mv.head) return null;
      }
      if (head !== m.head) return null;
      // A finished match kept here because archiving it failed. A forfeit (too many timeouts) ends without a move.
      if (m.phase === 'ended' && state.status !== 'ended') {
        const loser = m.clock.timeouts.findIndex((t) => t >= this.maxTimeouts);
        if (loser < 0) return null;
        const out = forfeit(state, loser as Seat);
        state = out.state;
        events.push(...out.events);
      }
      if ((state.status === 'ended') !== (m.phase === 'ended')) return null;
      // A finished match must also reproduce its result (that's what tells rules versions apart).
      if (m.phase === 'ended' && m.result) {
        const w = state.winner === 'draw' || state.winner === null ? ZERO_ADDRESS : m.players[state.winner].address;
        if (w.toLowerCase() !== m.result.winner.toLowerCase() || state.turn !== Number(m.result.turns)) return null;
      }
      return { rules, state, events };
    } catch { return null; }
  }

  /** A running-match record that can't be resumed: refund its league entry fees if they were charged. */
  abandon(rec: SavedMatch) {
    // Only a match that never finished: a played one keeps its result (and its fees went where they should).
    const unplayed = rec?.match?.phase === 'reveal' || rec?.match?.phase === 'active';
    if (unplayed && rec.match.mode === 'league' && rec.match.league?.state !== 'failed') this.league.refund(rec.match as Match);
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
