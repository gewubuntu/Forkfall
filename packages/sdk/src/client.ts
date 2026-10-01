import type { Action, CardDef, GameEvent, PlayerView, Race } from '@forkfall/engine';
import { randomHex32 } from '@forkfall/engine';
import type { Hex, LocalAccount, TypedDataDomain } from 'viem';
import {
  actionHash, commitSeed, MOVE_TYPES, RESULT_TYPES, sessionProofMessage, type Delegation, type MatchResult, type Mode,
} from './protocol.ts';
import type { Address } from 'viem';

/** Signs the final MatchResult with the player's wallet (wallet clients, smart wallets, etc.). */
export type ResultSigner = (typedData: {
  domain: TypedDataDomain; types: typeof RESULT_TYPES; primaryType: 'MatchResult'; message: MatchResult;
}) => Promise<Hex>;

export interface ClientOptions {
  /** Wallet identity when `account` is a session key (wallet login). */
  wallet?: Address;
  /** How the wallet signs results; defaults to `account`. */
  signResult?: ResultSigner;
}

export interface Me {
  address: Address;
  sessionKey: Address | null;
  expiresAt: number | null;
  agent: boolean;
  verifiedHuman: boolean;
  bannedFromRanked: boolean;
  onchain: boolean;
}

export interface ServerConfig {
  chainId: number;
  settlement: `0x${string}`;
  domain: TypedDataDomain;
  season: number;
  turnSeconds: number;
  bankSeconds: number;
}

export interface MatchSnapshot {
  matchId: Hex;
  phase: 'reveal' | 'active' | 'ended';
  mode: Mode;
  seat: 0 | 1 | null;
  players: { address: string; race: Race; agent: boolean }[];
  view: PlayerView | null;
  legalActions: Action[];
  seq: number;
  head: Hex;
  clock: { active: 0 | 1; turnEndsAt: number; bank: [number, number] } | null;
  eventCount: number;
  result?: MatchResult;
}

export interface QueueStatus { status: 'idle' | 'queued' | 'matched'; matchId?: Hex }

/**
 * Forkfall API client. The same client drives the web app, the agent SDK and the Bankr/MCP skill:
 * it authenticates by signature, signs every move with EIP-712 and co-signs the final result.
 */
export class ForkfallClient {
  token?: string;
  config?: ServerConfig;
  private secrets = new Map<string, { seedShare: Hex; deckSalt: Hex }>();

  /**
   * @param account signs moves: the player's own key (agents) or an authorized session key (wallet login).
   */
  constructor(readonly baseUrl: string, readonly account: LocalAccount, readonly opts: ClientOptions = {}) {}

  get address(): Address { return this.opts.wallet ?? this.account.address; }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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
    return r;
  }

  me() { return this.req<Me>('GET', '/v1/auth/me'); }

  async logout() {
    if (this.token) await this.req('POST', '/v1/auth/logout').catch(() => {});
    this.token = undefined;
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
    if (r.matchId && r.ticket && this.secrets.has(r.ticket)) this.secrets.set(r.matchId, this.secrets.get(r.ticket)!);
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

  /** Reveal seed share + private deck salt once matched (commit-reveal randomness). */
  async reveal(matchId: Hex) {
    if (!this.secrets.has(matchId)) await this.queueStatus();
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

  /** Co-sign the final result so it can be settled on-chain. */
  async signResult(matchId: Hex) {
    const { result } = await this.req<{ result: MatchResult }>('GET', `/v1/matches/${matchId}/result`);
    const typed = { domain: this.config!.domain, types: RESULT_TYPES, primaryType: 'MatchResult' as const, message: { ...result } };
    const signature = this.opts.signResult ? await this.opts.signResult(typed) : await this.account.signTypedData(typed);
    return this.req<{ ok: true; complete: boolean }>('POST', `/v1/matches/${matchId}/result`, { signature });
  }

  settlement(matchId: Hex) { return this.req<Record<string, unknown>>('GET', `/v1/matches/${matchId}/settlement`); }
  log(matchId: Hex) { return this.req<Record<string, unknown>>('GET', `/v1/matches/${matchId}/log`); }
  matches() { return this.req<{ matches: unknown[] }>('GET', '/v1/matches'); }
  leaderboard() { return this.req<{ rows: unknown[] }>('GET', '/v1/leaderboard'); }
}
