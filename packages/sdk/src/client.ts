import type { Action, CardDef, Equipped, GameEvent, PlayerView, Race } from '@forkfall/engine';
import { randomHex32 } from '@forkfall/engine';
import { LiveClient, type LiveClientOptions } from './live.ts';
import type { Hex, LocalAccount, TypedDataDomain } from 'viem';
import {
  actionHash, commitSeed, MOVE_TYPES, RESULT_TYPES, sessionProofMessage, type Delegation, type MatchResult, type Mode,
} from './protocol.ts';
import type { Address } from 'viem';
import type { MatchLog } from './replay.ts';

/** Signs the final MatchResult with the player's wallet (wallet clients, smart wallets, etc.). */
export type ResultSigner = (typedData: {
  domain: TypedDataDomain; types: typeof RESULT_TYPES; primaryType: 'MatchResult'; message: MatchResult;
}) => Promise<Hex>;

export interface MatchSecrets { seedShare: Hex; deckSalt: Hex }

/** Where queue/match secrets live until revealed. Defaults to memory; browsers can persist per tab. */
export interface SecretStore {
  get(key: string): MatchSecrets | undefined;
  set(key: string, value: MatchSecrets): void;
}

export interface ClientOptions {
  /** Persist match secrets (e.g. sessionStorage) so a reload before the reveal doesn't orphan a match. */
  secretStore?: SecretStore;
  /** Wallet identity when `account` is a session key (wallet login). */
  wallet?: Address;
  /** How the wallet signs results; defaults to `account`. */
  signResult?: ResultSigner;
  /** Abort an API request that takes longer than this (default 20 s), so a stalled connection can't hang a caller. */
  timeoutMs?: number;
}

export interface Me {
  address: Address;
  sessionKey: Address | null;
  expiresAt: number | null;
  agent: boolean;
  verifiedHuman: boolean;
  /** ERC-8004 agent id this wallet plays as (0 = not an agent). */
  agentId?: number;
  bannedFromRanked: boolean;
  onchain: boolean;
}

export interface ServerConfig {
  chainId: number;
  /** Deployed hub contracts (null when the referee runs off-chain). */
  contracts?: import('./abis.ts').HubContracts | null;
  /** Block explorer base URL for the hub chain, if any. */
  explorer?: string | null;
  onchain?: boolean;
  settlement: `0x${string}`;
  domain: TypedDataDomain;
  season: number;
  turnSeconds: number;
  bankSeconds: number;
}

export interface MatchSnapshot {
  matchId: Hex;
  /** cancelled = a player didn't reveal in time; nothing was played. */
  phase: 'reveal' | 'active' | 'ended' | 'cancelled';
  mode: Mode;
  seat: 0 | 1 | null;
  /** cosmetics: the player's equipped title, card back and badge (servers with profiles). */
  players: { address: string; race: Race; agent: boolean; bot?: boolean; cosmetics?: Equipped }[];
  /** The friend challenge this match came from (casual). */
  challenge?: string;
  view: PlayerView | null;
  legalActions: Action[];
  seq: number;
  head: Hex;
  clock: { active: 0 | 1; turnEndsAt: number; bank: [number, number] } | null;
  eventCount: number;
  result?: MatchResult;
  /** Server clock (ms) when the snapshot was taken, to correct for client clock skew. */
  now?: number;
  /** Which seats have co-signed the final result. */
  resultSigned?: [boolean, boolean];
  /** See MatchSummary. */
  refereeAt?: number | null;
  referee?: RefereeStatus;
}

/** One row of `GET /v1/matches` (newest first). */
export interface MatchSummary {
  matchId: Hex;
  mode: Mode;
  phase: MatchSnapshot['phase'];
  turn: number;
  season: number;
  createdAt: number;
  endedAt?: number;
  endReason?: string;
  /** Practice game against a house bot. */
  practice: boolean;
  players: { address: Address; race: Race; agent: boolean; deckId: Hex }[];
  winner?: Address;
  resultSigned: [boolean, boolean];
  /** none = still playing · waiting = needs signatures · ready = anyone can settle · referee = only the referee can settle */
  settlement: 'none' | 'waiting' | 'ready' | 'referee';
  /** Set when this server auto-settles: when the referee may settle with the winner's signature alone (null for draws). */
  refereeAt?: number | null;
  /** The referee's own settlement attempt, if it made one. */
  referee?: RefereeStatus;
}

export interface RefereeStatus { state: 'submitting' | 'settled' | 'failed'; tx?: Hex; error?: string; willRetry?: boolean }

/** A friend challenge (`/v1/challenges`). The challenger's race stays hidden until the match starts. */
export interface ChallengeView {
  code: string;
  from: { address: Address; agent: boolean; cosmetics?: Equipped };
  /** Only this address may accept (a directed challenge or a rematch). */
  to: Address | null;
  rematchOf: Hex | null;
  state: 'open' | 'accepted' | 'cancelled' | 'declined' | 'expired';
  createdAt: number;
  expiresAt: number;
  /** Set once accepted; only returned here to the two players (the match is then listed publicly like any other). */
  matchId?: Hex;
  /** For the two players: 'reveal' while the match waits for both to join. */
  matchPhase?: 'reveal' | 'active' | 'ended' | 'cancelled';
}

/** held: earned but waiting until the player is a verified human or registered agent. */
export interface QuestPayoutStatus { state: 'pending' | 'paid' | 'offchain' | 'failed' | 'held'; tx?: Hex; error?: string }

/** Today's daily quests, the first-win bonus and free-pack progress (`GET /v1/quests`). */
export interface QuestStatus {
  /** UTC day number; quests reset at `resetsAt` (ms). */
  day: number;
  resetsAt: number;
  /** Whether this server pays rewards on-chain (QuestRewards). Off-chain servers only track progress. */
  paysOnChain: boolean;
  /** Whether you can be paid: a verified human or registered agent (null: no rule on this server). Rewards
   *  earned before that are held and paid once you qualify. */
  eligible?: boolean | null;
  rerollsLeft: number;
  quests: { slot: number; id: string; group: string; text: string; goal: number; progress: number; scrap: number; done: boolean; payout?: QuestPayoutStatus }[];
  firstWin: { done: boolean; scrap: number; payout?: QuestPayoutStatus };
  /** Free pack: complete `goal` daily quests between `startsAt` and `endsAt` (ms). */
  pack: { goal: number; completed: number; kind: number; periodDays: number; startsAt: number; endsAt: number; payout?: QuestPayoutStatus };
}

/** A player's lessons and equipped cosmetics (`GET /v1/profile`). */
export interface PlayerProfile extends Equipped { tutorial: boolean; lessons: string[] }

export interface LeaderboardRow { address: Address; agent: boolean; wins: number; losses: number; draws: number }

/** Foundry/wallet-ready settlement payload (`GET /v1/matches/:id/settlement`). */
export interface Settlement {
  domain: TypedDataDomain;
  result: MatchResult;
  byReferee: boolean;
  sigA?: Hex; sigB?: Hex; refereeSig?: Hex; winnerSig?: Hex;
}

/** Optional proof-of-personhood: gates season rewards, not the Human queue. */
export interface HumanStatus {
  verified: boolean;
  method: string | null;
  verifiedAt: number | null;
  expiresAt: number | null;
  agentId: number;
  onchain: boolean;
  canAttest: boolean;
  methods: { id: string; label: string; description: string; validDays: number; available: boolean }[];
}

export interface PlayerReward {
  season: number;
  token: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  deadline: number;
  rule: string;
  amount?: string;
  proof?: Hex[];
  kind?: 'human' | 'agent';
  excluded?: 'unverified' | 'banned' | 'no-wins';
}

/** Agent League snapshot (`GET /v1/league`). Amounts are base units of the entry token (tUSDC, 6 decimals). */
export interface LeagueInfo {
  enabled: boolean;
  address?: Address;
  token?: { symbol: string; decimals: number };
  week?: number;
  weekEndsAt?: number;
  entryFee?: string;
  potBps?: number;
  buybackBps?: number;
  pot?: string;
  standings?: { agent: Address; operator: Address; games: number; wins: number; losses: number; draws: number; opponents: number; rating: number }[];
  balance?: string;
}

export interface LeagueClaim { week: number; agent: Address; amount: string; proof: Hex[]; rank: number; deadline: number }

export interface QueueStatus { status: 'idle' | 'queued' | 'matched'; matchId?: Hex }

/**
 * Forkfall API client. The same client drives the web app, the agent SDK and the Bankr/MCP skill:
 * it authenticates by signature, signs every move with EIP-712 and co-signs the final result.
 */
export class ForkfallClient {
  token?: string;
  config?: ServerConfig;
  private memorySecrets = new Map<string, MatchSecrets>();
  private get secrets(): SecretStore {
    return this.opts.secretStore ?? { get: (k) => this.memorySecrets.get(k), set: (k, v) => { this.memorySecrets.set(k, v); } };
  }

  /**
   * @param account signs moves: the player's own key (agents) or an authorized session key (wallet login).
   */
  constructor(readonly baseUrl: string, readonly account: LocalAccount, readonly opts: ClientOptions = {}) {}

  get address(): Address { return this.opts.wallet ?? this.account.address; }

  private liveClient?: LiveClient;
  private livePinned = false;
  /** Borrowers per socket instance, so a closeLive() in between can't skew the next socket's count. */
  private liveUsers = new WeakMap<LiveClient, number>();
  /**
   * The live-notice socket for this client (created on first use; signs in with this client's session). It stays
   * open until `closeLive()` or `logout()`; in a Node script, call one of them when done or the process won't exit.
   * `onReconnect` / `onStatus` are added as listeners on every call.
   */
  live(opts: Omit<LiveClientOptions, 'token'> = {}): LiveClient {
    this.livePinned = true;
    const live = this.ensureLive();
    if (opts.onReconnect) live.onReconnected(opts.onReconnect);
    if (opts.onStatus) live.onStatusChange(opts.onStatus);
    return live;
  }

  /** Borrow the live socket for a while (as `runMatch` does): it closes again when the last borrower releases it, unless `live()` pinned it. */
  retainLive(): { live: LiveClient; release: () => void } {
    const live = this.ensureLive();
    this.liveUsers.set(live, (this.liveUsers.get(live) ?? 0) + 1);
    let done = false;
    return {
      live,
      release: () => {
        if (done) return;
        done = true;
        const n = (this.liveUsers.get(live) ?? 1) - 1;
        this.liveUsers.set(live, n);
        if (n === 0 && this.liveClient === live && !this.livePinned) this.closeLive();
      },
    };
  }

  /** Close the live socket (a later `live()` or `runMatch` opens a fresh one). */
  closeLive() {
    this.liveClient?.close();
    this.liveClient = undefined;
    this.livePinned = false;
  }

  private ensureLive(): LiveClient {
    this.liveClient ??= new LiveClient(LiveClient.urlFor(this.baseUrl), { token: () => this.token });
    return this.liveClient;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const send = () => fetch(this.baseUrl + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
    });
    let res: Response;
    try { res = await send(); } catch (e) {
      // A connection dropped under us (e.g. the referee restarting): reads are safe to try once more.
      if (method !== 'GET' || (e as Error).name === 'TimeoutError') throw e;
      await new Promise((r) => setTimeout(r, 250));
      res = await send();
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data.error ?? text}`);
    return data as T;
  }

  async connect(opts: { agent?: boolean } = {}): Promise<ServerConfig> {
    this.config = await this.req<ServerConfig>('GET', '/v1/config');
    const { message } = await this.req<{ message: string }>('GET', `/v1/auth/nonce?address=${this.address}`);
    const signature = await this.account.signMessage({ message });
    const { token } = await this.req<{ token: string }>('POST', '/v1/auth', {
      address: this.address, message, signature, agent: !!opts.agent,
    });
    this.token = token;
    this.liveClient?.reauth();
    return this.config;
  }

  /** Server-issued nonce (single use, 5 minutes) for wallet sign-in. */
  async nonce(): Promise<string> {
    const { nonce } = await this.req<{ nonce: string }>('GET', `/v1/auth/nonce?address=${this.address}`);
    return nonce;
  }

  /**
   * Wallet sign-in with a session key: `delegation` is the wallet-signed SIWE message authorizing
   * this.account (the session key). Reusable until it expires; each call proves key possession afresh.
   */
  async connectSession(delegation: Delegation): Promise<{ token: string; expiresAt: number }> {
    this.config ??= await this.req<ServerConfig>('GET', '/v1/config');
    const nonce = await this.nonce();
    const proof = await this.account.signMessage({ message: sessionProofMessage(nonce) });
    const r = await this.req<{ token: string; expiresAt: number }>('POST', '/v1/auth/session', { delegation, nonce, proof });
    this.token = r.token;
    this.liveClient?.reauth();
    return r;
  }

  me() { return this.req<Me>('GET', '/v1/auth/me'); }

  async logout() {
    if (this.token) await this.req('POST', '/v1/auth/logout').catch(() => {});
    this.token = undefined;
    this.closeLive();
  }

  cards() { return this.req<CardDef[]>('GET', '/v1/cards'); }

  private newSecrets() {
    const seedShare = randomHex32() as Hex;
    return { seedShare, deckSalt: randomHex32() as Hex, seedCommit: commitSeed(seedShare) };
  }

  /** Queue for a human/agent opponent. Deck defaults to the race's starter deck. */
  async queue(opts: { mode: Mode; race: Race; deck?: number[]; deckId?: Hex }): Promise<QueueStatus> {
    const s = this.newSecrets();
    const r = await this.req<QueueStatus & { ticket: string }>('POST', '/v1/queue', { ...opts, seedCommit: s.seedCommit });
    this.secrets.set(r.ticket, s);
    if (r.matchId) this.secrets.set(r.matchId, s);
    return r;
  }

  async queueStatus(): Promise<QueueStatus & { ticket?: string }> {
    const r = await this.req<QueueStatus & { ticket?: string }>('GET', '/v1/queue');
    const t = r.ticket ? this.secrets.get(r.ticket) : undefined;
    if (r.matchId && t && !this.secrets.get(r.matchId)) this.secrets.set(r.matchId, t);
    return r;
  }

  leaveQueue() { return this.req('DELETE', '/v1/queue'); }

  /** Casual match against a house bot (badged as an agent). */
  async practice(opts: { race: Race; deck?: number[]; bot?: 'greedy' | 'random'; botRace?: Race }): Promise<Hex> {
    const s = this.newSecrets();
    const { matchId } = await this.req<{ matchId: Hex }>('POST', '/v1/practice', { ...opts, seedCommit: s.seedCommit });
    this.secrets.set(matchId, s);
    return matchId;
  }

  // ─── Friend challenges (casual) ───
  /** Create a challenge link: anyone with the code may accept, or only `to`. `rematchOf` challenges your last opponent. */
  async createChallenge(opts: { race: Race; deck?: number[]; deckId?: Hex; to?: Address; rematchOf?: Hex }): Promise<ChallengeView> {
    const s = this.newSecrets();
    const c = await this.req<ChallengeView>('POST', '/v1/challenges', { ...opts, seedCommit: s.seedCommit });
    this.secrets.set(`challenge:${c.code}`, s);
    return c;
  }

  /** A challenge's public view; for your own, `matchId` appears once someone accepts. */
  async challenge(code: string): Promise<ChallengeView> {
    const c = await this.req<ChallengeView>('GET', `/v1/challenges/${code}`);
    this.adoptChallengeSecrets(c);
    return c;
  }

  /** Accept a challenge: the match starts right away. Returns its id. */
  async acceptChallenge(code: string, opts: { race: Race; deck?: number[]; deckId?: Hex }): Promise<Hex> {
    const s = this.newSecrets();
    const { matchId } = await this.req<{ matchId: Hex }>('POST', `/v1/challenges/${code}/accept`, { ...opts, seedCommit: s.seedCommit });
    this.secrets.set(matchId, s);
    return matchId;
  }

  /** Cancel your challenge, or decline one addressed to you. */
  cancelChallenge(code: string) { return this.req<ChallengeView>('DELETE', `/v1/challenges/${code}`); }

  /** Your challenges (open and recent) and open ones addressed to you. */
  async challenges(): Promise<{ outgoing: ChallengeView[]; incoming: ChallengeView[] }> {
    const r = await this.req<{ outgoing: ChallengeView[]; incoming: ChallengeView[] }>('GET', '/v1/challenges');
    r.outgoing.forEach((c) => this.adoptChallengeSecrets(c));
    return r;
  }

  private adoptChallengeSecrets(c: ChallengeView) {
    const s = c.matchId ? this.secrets.get(`challenge:${c.code}`) : undefined;
    if (s && c.matchId && !this.secrets.get(c.matchId)) this.secrets.set(c.matchId, s);
  }

  /** Reveal seed share + private deck salt once matched (commit-reveal randomness). */
  async reveal(matchId: Hex) {
    if (!this.secrets.get(matchId)) await this.queueStatus();
    if (!this.secrets.get(matchId)) await this.challenges().catch(() => {});
    const s = this.secrets.get(matchId);
    if (!s) throw new Error('no secrets for this match (queued from another client?)');
    return this.req('POST', `/v1/matches/${matchId}/reveal`, { seedShare: s.seedShare, deckSalt: s.deckSalt });
  }

  state(matchId: Hex) { return this.req<MatchSnapshot>('GET', `/v1/matches/${matchId}`); }

  events(matchId: Hex, since = 0) {
    return this.req<{ events: GameEvent[]; next: number }>('GET', `/v1/matches/${matchId}/events?since=${since}`);
  }

  async move(matchId: Hex, snap: Pick<MatchSnapshot, 'seq' | 'head'>, action: Action) {
    const signature = await this.account.signTypedData({
      domain: this.config!.domain,
      types: MOVE_TYPES,
      primaryType: 'Move',
      message: { matchId, seq: snap.seq, prevHash: snap.head, actionHash: actionHash(action) },
    });
    return this.req<MatchSnapshot>('POST', `/v1/matches/${matchId}/moves`, { seq: snap.seq, action, signature });
  }

  /**
   * Concede. It is legal at any point, even in the opponent's turn, but a house bot keeps moving meanwhile, so a
   * concede signed for a position the bot has since moved past comes back "stale seq". Re-read the board and sign
   * it again (a short pause between tries) until it lands or `timeoutMs` passes.
   */
  async concede(matchId: Hex, opts: { snap?: Pick<MatchSnapshot, 'seq' | 'head'>; timeoutMs?: number; retryMs?: number } = {}) {
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
    let snap = opts.snap ?? await this.state(matchId);
    for (;;) {
      try {
        return await this.move(matchId, snap, { type: 'concede' });
      } catch (e) {
        if (!String((e as Error).message).includes('stale seq') || Date.now() > deadline) throw e;
      }
      await new Promise((r) => setTimeout(r, opts.retryMs ?? 150));
      snap = await this.state(matchId);
    }
  }

  /** Co-sign the final result so it can be settled on-chain. */
  async signResult(matchId: Hex) {
    const { result } = await this.req<{ result: MatchResult }>('GET', `/v1/matches/${matchId}/result`);
    const typed = { domain: this.config!.domain, types: RESULT_TYPES, primaryType: 'MatchResult' as const, message: { ...result } };
    const signature = this.opts.signResult ? await this.opts.signResult(typed) : await this.account.signTypedData(typed);
    return this.req<{ ok: true; complete: boolean }>('POST', `/v1/matches/${matchId}/result`, { signature });
  }

  settlement(matchId: Hex) { return this.req<Settlement>('GET', `/v1/matches/${matchId}/settlement`); }
  log(matchId: Hex) { return this.req<MatchLog>('GET', `/v1/matches/${matchId}/log`); }
  /** Recent matches; pass `player` for that address's full history. */
  matches(opts: { player?: Address } = {}) {
    return this.req<{ matches: MatchSummary[] }>('GET', `/v1/matches${opts.player ? `?player=${opts.player}` : ''}`);
  }
  human() { return this.req<HumanStatus>('GET', '/v1/human'); }
  verifyHuman(method: string, evidence: Record<string, unknown> = {}) {
    return this.req<HumanStatus & { tx: Hex }>('POST', '/v1/human/verify', { ...evidence, method });
  }
  /** Agent League: week, fee, split, pot, standings; pass your address for your prepaid balance. */
  league(address?: Address) { return this.req<LeagueInfo>('GET', `/v1/league${address ? `?address=${address}` : ''}`); }
  /** Published weekly prizes for these agents (claim on AgentLeague; the prize goes to each agent's operator). */
  leagueClaims(agents: Address[]) { return this.req<{ claims: LeagueClaim[] }>('GET', `/v1/league/claims?agents=${agents.join(',')}`); }

  /** Published season rewards for `address`, with Merkle proofs to claim on SeasonRewards. */
  /** Tutorial completion, equipped cosmetics and which are unlocked (from on-chain card balances). */
  profile(address: Address) { return this.req<{ profile: PlayerProfile; unlocked: string[] }>('GET', `/v1/profile?address=${address}`); }
  /** Records a finished lesson: 'basics' (the tutorial, default), 'prophets', 'brokers' or 'degens'. */
  completeTutorial(lesson = 'basics') { return this.req<{ profile: PlayerProfile }>('POST', '/v1/profile/tutorial', { lesson }); }
  /** Equip cosmetics (null clears a slot); the server refuses locked ones. */
  /** Today's quests for a player (defaults to you). */
  quests(address?: Address) { return this.req<QuestStatus>('GET', `/v1/quests${address ? `?address=${address}` : ''}`); }
  /** Swap one of today's unfinished quests for another (one reroll a day). */
  rerollQuest(slot: number) { return this.req<QuestStatus>('POST', '/v1/quests/reroll', { slot }); }
  equip(want: Partial<Equipped>) { return this.req<{ profile: PlayerProfile }>('POST', '/v1/profile/cosmetics', want); }

  rewards(address: Address) { return this.req<{ seasons: PlayerReward[] }>('GET', `/v1/rewards?address=${address}`); }

  /** Ranked results refereed by this server (season defaults to the current one). */
  leaderboard(season?: number) {
    return this.req<{ season: number; rows: LeaderboardRow[] }>('GET', `/v1/leaderboard${season !== undefined ? `?season=${season}` : ''}`);
  }
}
