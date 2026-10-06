import { readFileSync, existsSync } from 'node:fs';
import { COLLECTIBLE } from '@forkfall/engine';
import {
  agentLeagueAbi, agentRegistryAbi, cardRegistryAbi, deckRegistryAbi, humanRegistryAbi, matchSettlementAbi, packGiftsAbi, questRewardsAbi, seasonPassAbi, vrfCoordinatorMockAbi,
  type MatchResult,
} from '@forkfall/sdk';
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, http,
  type Address, type Hex, type LocalAccount, type PublicClient,
} from 'viem';

const TESTNETS = new Set([31337, 84532, 46630, 11155111]);

export const BASE_SEPOLIA = 84532;
export const ANVIL = 31337;

/** Public RPC defaults per testnet (override with RPC_URL). */
export const DEFAULT_RPC: Record<number, string> = {
  [BASE_SEPOLIA]: 'https://sepolia.base.org',
  46630: 'https://rpc.testnet.chain.robinhood.com/rpc',
  [ANVIL]: 'http://127.0.0.1:8545',
};

export const EXPLORER: Record<number, string> = {
  [BASE_SEPOLIA]: 'https://sepolia.basescan.org',
  46630: 'https://explorer.testnet.chain.robinhood.com',
};

export interface AddressBook {
  chainId: number;
  deployer?: Address;
  deployedAtBlock?: number;
  MatchSettlement: Address;
  AgentRegistry: Address;
  HumanRegistry: Address;
  DeckRegistry: Address;
  CardRegistry?: Address;
  [k: string]: unknown;
}

export interface Preflight { ok: boolean; errors: string[]; warnings: string[]; notes: string[] }

/**
 * Read-only view of the on-chain hub. Optional: without an RPC the server runs fully off-chain
 * (casual play, dev) and ranked checks fall back to engine-side deck validation.
 */
export class Chain {
  readonly client?: PublicClient;
  readonly rpcUrl?: string;
  /**
   * @param book address book from contracts/deployments/<chainId>.json (null = not deployed / off-chain)
   * @param rpcUrl enables on-chain checks; ignored without a book
   * @param hubChainId chain the server signs for when running without a book (off-chain mode)
   */
  constructor(readonly book: AddressBook | null, rpcUrl?: string, readonly hubChainId = ANVIL) {
    const id = book?.chainId ?? hubChainId;
    if (!TESTNETS.has(id)) throw new Error(`chain ${id} is not an allowed testnet`);
    if (book && rpcUrl) {
      this.rpcUrl = rpcUrl;
      this.client = createPublicClient({ transport: http(rpcUrl) }) as PublicClient;
    }
  }

  static load(bookFile?: string, rpcUrl?: string, hubChainId = ANVIL): Chain {
    if (!bookFile || !existsSync(bookFile)) return new Chain(null, undefined, hubChainId);
    const book = JSON.parse(readFileSync(bookFile, 'utf8')) as AddressBook;
    if (book.chainId !== hubChainId) throw new Error(`${bookFile} is for chain ${book.chainId}, but CHAIN_ID is ${hubChainId}`);
    return new Chain(book, rpcUrl, hubChainId);
  }

  get online() { return !!this.client; }
  get chainId() { return this.book?.chainId ?? this.hubChainId; }

  /** Startup checks: right chain, contracts deployed, referee key authorized and funded. */
  async preflight(referee: Address): Promise<Preflight> {
    const r: Preflight = { ok: true, errors: [], warnings: [], notes: [] };
    if (!this.client || !this.book) return r;
    try {
      const rpcChain = await this.client.getChainId();
      if (rpcChain !== this.book.chainId) r.errors.push(`RPC is on chain ${rpcChain}, address book is for ${this.book.chainId}`);
    } catch (e) {
      r.errors.push(`RPC unreachable: ${(e as Error).message.split('\n')[0]}`);
      r.ok = false;
      return r;
    }
    if (r.errors.length) { r.ok = false; return r; }
    const code = await this.client.getCode({ address: this.book.MatchSettlement }).catch(() => undefined);
    if (!code || code === '0x') r.errors.push(`no contract at MatchSettlement ${this.book.MatchSettlement} (wrong address book?)`);
    else {
      const role = await this.client.readContract({ address: this.book.MatchSettlement, abi: matchSettlementAbi, functionName: 'REFEREE_ROLE' });
      const isRef = await this.client.readContract({ address: this.book.MatchSettlement, abi: matchSettlementAbi, functionName: 'hasRole', args: [role, referee] });
      if (!isRef) r.errors.push(`referee ${referee} lacks REFEREE_ROLE: ranked results could not settle. Use the REFEREE_ADDRESS key from deployment as HOUSE_PRIVATE_KEY.`);
      const season = await this.season();
      r.notes.push(`season ${season}`);
    }
    const bal = await this.client.getBalance({ address: referee }).catch(() => 0n);
    if (bal === 0n) r.warnings.push(`referee ${referee} has no ETH: it can co-sign results, but cannot auto-settle matches the loser never signed (settleByReferee). Fund it with testnet ETH.`);
    r.ok = r.errors.length === 0;
    return r;
  }
  get settlement(): Address { return this.book?.MatchSettlement ?? '0x0000000000000000000000000000000000000000'; }

  async isAgent(a: Address) {
    if (!this.client) return false;
    return this.client.readContract({ address: this.book!.AgentRegistry, abi: agentRegistryAbi, functionName: 'isAgent', args: [a] });
  }
  async isBanned(a: Address) {
    if (!this.client) return false;
    return this.client.readContract({ address: this.book!.AgentRegistry, abi: agentRegistryAbi, functionName: 'bannedFromRanked', args: [a] });
  }
  /** Agent id this wallet plays as (0 = not an agent). */
  async agentOf(a: Address): Promise<number> {
    if (!this.client) return 0;
    return Number(await this.client.readContract({ address: this.book!.AgentRegistry, abi: agentRegistryAbi, functionName: 'agentOf', args: [a] }));
  }
  async humanVerification(a: Address): Promise<{ method: Hex; verifiedAt: number; expiresAt: number } | null> {
    if (!this.client) return null;
    const [method, verifiedAt, expiresAt] = await this.client.readContract({ address: this.book!.HumanRegistry, abi: humanRegistryAbi, functionName: 'verification', args: [a] });
    return verifiedAt === 0n ? null : { method, verifiedAt: Number(verifiedAt), expiresAt: Number(expiresAt) };
  }
  async isHuman(a: Address) {
    if (!this.client) return false;
    return this.client.readContract({ address: this.book!.HumanRegistry, abi: humanRegistryAbi, functionName: 'isVerifiedHuman', args: [a] });
  }
  /** Whether this deployment sells the season pass (SeasonPass in the address book). */
  get hasSeasonPass() { return !!this.client && !!this.book?.SeasonPass; }
  /** Whether a player holds a season's premium pass. */
  async hasPass(a: Address, season: number): Promise<boolean> {
    if (!this.client || !this.book?.SeasonPass) return false;
    return this.client.readContract({ address: this.book.SeasonPass as Address, abi: seasonPassAbi, functionName: 'hasPass', args: [season, a] });
  }
  async season(): Promise<number> {
    if (!this.client) return 1;
    return Number(await this.client.readContract({ address: this.book!.MatchSettlement, abi: matchSettlementAbi, functionName: 'currentSeason' }));
  }
  /** The player's ranked rating this season, or null off-chain (the contract reports START_RATING before any game). */
  async rating(season: number, player: Address): Promise<number | null> {
    if (!this.client) return null;
    const s = await this.client.readContract({ address: this.book!.MatchSettlement, abi: matchSettlementAbi, functionName: 'stats', args: [season, player] });
    return s.rating;
  }
  /** Copies of each collectible card the player owns (tradeable + soulbound starter + foil), or null off-chain. */
  async ownedCounts(player: Address): Promise<Map<number, number> | null> {
    if (!this.client || !this.book?.CardRegistry) return null;
    const ids = COLLECTIBLE.map((c) => BigInt(c.id));
    const all = [...ids, ...ids.map((i) => i + 10_000n), ...ids.map((i) => i + 20_000n)];
    const b = await this.client.readContract({ address: this.book.CardRegistry, abi: cardRegistryAbi, functionName: 'balanceOfBatch', args: [all.map(() => player), all] });
    const m = new Map<number, number>();
    COLLECTIBLE.forEach((c, i) => m.set(c.id, Number(b[i] + b[i + ids.length] + b[i + 2 * ids.length])));
    return m;
  }

  async deck(deckId: Hex, player: Address, ranked: boolean): Promise<{ race: number; cardIds: number[] } | null> {
    if (!this.client) return null;
    const ok = await this.client.readContract({ address: this.book!.DeckRegistry, abi: deckRegistryAbi, functionName: 'isValidFor', args: [deckId, player, ranked] });
    if (!ok) return null;
    const d = await this.client.readContract({ address: this.book!.DeckRegistry, abi: deckRegistryAbi, functionName: 'getDeck', args: [deckId] });
    return { race: d.race, cardIds: d.cardIds.map(Number) };
  }
}

/** Referee writes: settle a result with only the winner's signature when the loser never signs. */
export interface RefereeSettler {
  isSettled(matchId: Hex): Promise<boolean>;
  /** Submits `settleByReferee` and resolves with the tx hash once it is mined successfully. */
  settleByReferee(result: MatchResult, winnerSig: Hex): Promise<Hex>;
  /** Submits a fully signed result (`settle`); used for league matches, where agents don't settle themselves. */
  settle(result: MatchResult, sigA: Hex, sigB: Hex, refereeSig: Hex): Promise<Hex>;
}

/** Simulate (so reverts surface with their reason and cost no gas), send, wait for success. */
function writer(chain: Chain, account: LocalAccount) {
  const client = chain.client!;
  const wallet = createWalletClient({ account, transport: http(chain.rpcUrl!) });
  return async (address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<Hex> => {
    try {
      const { request } = await client.simulateContract({ account, address, abi, functionName, args } as never);
      const hash = await wallet.writeContract({ ...(request as object), chain: null } as never);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`${functionName} reverted (${hash})`);
      return hash;
    } catch (e) {
      throw new Error(revertReason(e));
    }
  };
}

const forContract = (r: MatchResult) => ({ ...r, mode: Number(r.mode), season: Number(r.season), turns: Number(r.turns) });

/**
 * Local Anvil only: answers the mock VRF coordinator's queued requests, as Chainlink's nodes do on real networks.
 * Returns null anywhere else (no VRFCoordinatorMock in the address book).
 */
export function devVrfFulfiller(chain: Chain, account: LocalAccount): (() => Promise<Hex | null>) | null {
  const mock = chain.book?.VRFCoordinatorMock as Address | undefined;
  if (!chain.client || !mock || !chain.rpcUrl || chain.chainId !== ANVIL) return null;
  const client = chain.client;
  const send = writer(chain, account);
  return async () => {
    const pending = await client.readContract({ address: mock, abi: vrfCoordinatorMockAbi, functionName: 'pending' });
    return pending > 0n ? send(mock, vrfCoordinatorMockAbi, 'fulfillPending', []) : null;
  };
}

/** Daily quest payouts through QuestRewards (the referee holds REWARDER_ROLE). */
export interface QuestRewarder {
  reward(player: Address, claimId: Hex, scrap: number, packKind: number, packCount: number): Promise<Hex>;
  claimed(claimId: Hex): Promise<boolean>;
}

/** A pack gift held for a friend challenge (PackGifts.gifts). */
export interface HeldGift { from: Address; kind: number; count: number; state: 'none' | 'held' | 'delivered' | 'refunded'; refundableAt: number }

/** The referee's side of PackGifts: read a held gift, and deliver it after the challenge match. */
export interface GiftDeliverer {
  read(giftId: Hex): Promise<HeldGift>;
  deliver(giftId: Hex, to: Address): Promise<Hex>;
}

export function giftDeliverer(chain: Chain, referee: LocalAccount): GiftDeliverer | null {
  if (!chain.client || !chain.book?.PackGifts || !chain.rpcUrl) return null;
  const client = chain.client;
  const address = chain.book.PackGifts as Address;
  const send = writer(chain, referee);
  const states = ['none', 'held', 'delivered', 'refunded'] as const;
  return {
    read: async (giftId) => {
      const [from, kind, count, state, refundableAt] = await client.readContract({ address, abi: packGiftsAbi, functionName: 'gifts', args: [giftId] });
      return { from, kind, count, state: states[state] ?? 'none', refundableAt: refundableAt * 1000 };
    },
    deliver: (giftId, to) => send(address, packGiftsAbi, 'deliver', [giftId, to]),
  };
}

export function questRewarder(chain: Chain, referee: LocalAccount): QuestRewarder | null {
  if (!chain.client || !chain.book?.QuestRewards || !chain.rpcUrl) return null;
  const client = chain.client;
  const address = chain.book.QuestRewards as Address;
  const send = writer(chain, referee);
  return {
    reward: (player, claimId, scrap, packKind, packCount) =>
      send(address, questRewardsAbi, 'reward', [player, claimId, BigInt(scrap), packKind, BigInt(packCount)]),
    claimed: (claimId) => client.readContract({ address, abi: questRewardsAbi, functionName: 'claimed', args: [claimId] }),
  };
}

export function refereeSettler(chain: Chain, referee: LocalAccount): RefereeSettler | null {
  if (!chain.client || !chain.book || !chain.rpcUrl) return null;
  const client = chain.client;
  const address = chain.book.MatchSettlement;
  const send = writer(chain, referee);
  return {
    isSettled: (matchId) => client.readContract({ address, abi: matchSettlementAbi, functionName: 'settled', args: [matchId] }),
    settleByReferee: (result, winnerSig) => send(address, matchSettlementAbi, 'settleByReferee', [forContract(result), winnerSig]),
    settle: (result, sigA, sigB, refereeSig) => send(address, matchSettlementAbi, 'settle', [forContract(result), sigA, sigB, refereeSig]),
  };
}

/** Agent League operations: reads for matchmaking and the referee's start/cancel (fees are charged at start). */
export interface LeagueOps {
  entryFee(): Promise<bigint>;
  currentWeek(): Promise<number>;
  balanceOf(agent: Address): Promise<bigint>;
  operatorOf(agent: Address): Promise<Address>;
  /** The agent's league rating this week (START_RATING before its first rated game); used for pairing. */
  rating?(week: number, agent: Address): Promise<number>;
  start(matchId: Hex, a: Address, b: Address): Promise<Hex>;
  /** Whether the league already charged this match (started on-chain). */
  started(matchId: Hex): Promise<boolean>;
  cancel(matchId: Hex): Promise<Hex>;
  info(address?: Address | null): Promise<LeagueInfo>;
}

export interface LeagueInfo {
  enabled: true;
  address: Address;
  token: { symbol: string; decimals: number };
  week: number;
  weekEndsAt: number;
  entryFee: string;
  potBps: number;
  buybackBps: number;
  pot: string;
  standings: { agent: Address; operator: Address; games: number; wins: number; losses: number; draws: number; opponents: number; rating: number }[];
  balance?: string;
}

export function leagueOps(chain: Chain, referee: LocalAccount): LeagueOps | null {
  if (!chain.client || !chain.book?.AgentLeague || !chain.rpcUrl) return null;
  const client = chain.client;
  const address = chain.book.AgentLeague as Address;
  const send = writer(chain, referee);
  const read = <T,>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi: agentLeagueAbi, functionName, args } as never) as Promise<T>;
  return {
    entryFee: () => read<bigint>('entryFee'),
    currentWeek: async () => Number(await read<number>('currentWeek')),
    balanceOf: (agent) => read<bigint>('balanceOf', [agent]),
    operatorOf: (agent) => read<Address>('operatorOf', [agent]),
    rating: async (week, agent) => (await read<{ rating: number }>('standing', [week, agent])).rating,
    start: (matchId, a, b) => send(address, agentLeagueAbi, 'startMatch', [matchId, a, b]),
    cancel: (matchId) => send(address, agentLeagueAbi, 'cancelMatch', [matchId]),
    // matches(id).state: 0 = None (never charged); anything else means startMatch went through.
    started: async (matchId) => Number((await read<readonly [Address, Address, number, number, bigint]>('matches', [matchId]))[3]) !== 0,
    async info(me) {
      const week = Number(await read<number>('currentWeek'));
      const [fee, potBps, buybackBps, pot, endsAt, players] = await Promise.all([
        read<bigint>('entryFee'), read<number>('potBps'), read<number>('buybackBps'), read<bigint>('pot', [week]),
        read<bigint>('weekEndsAt', [week]), read<Address[]>('players', [week]),
      ]);
      const standings = await Promise.all(players.map(async (agent) => {
        const [s, operator] = await Promise.all([
          read<{ games: number; wins: number; losses: number; draws: number; opponents: number; rating: number }>('standing', [week, agent]),
          read<Address>('operatorOf', [agent]),
        ]);
        return { agent, operator, games: s.games, wins: s.wins, losses: s.losses, draws: s.draws, opponents: s.opponents, rating: s.rating };
      }));
      standings.sort((x, y) => y.rating - x.rating || y.wins - x.wins);
      return {
        enabled: true, address, token: { symbol: 'tUSDC', decimals: 6 }, week, weekEndsAt: Number(endsAt),
        entryFee: fee.toString(), potBps: Number(potBps), buybackBps: Number(buybackBps), pot: pot.toString(), standings,
        ...(me ? { balance: (await read<bigint>('balanceOf', [me])).toString() } : {}),
      };
    },
  };
}

function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (rev?.data?.errorName) return `${rev.data.errorName}(${(rev.data.args ?? []).join(', ')})`;
    return e.shortMessage;
  }
  return (e as Error).message;
}

/** Referee attestations in HumanRegistry (needs ATTESTOR_ROLE and testnet ETH on the referee key). */
export interface HumanAttestor {
  attest(player: Address, method: Hex, expiresAt: number): Promise<Hex>;
}

export function humanAttestor(chain: Chain, referee: LocalAccount): HumanAttestor | null {
  if (!chain.client || !chain.book || !chain.rpcUrl) return null;
  const client = chain.client;
  const address = chain.book.HumanRegistry;
  const wallet = createWalletClient({ account: referee, transport: http(chain.rpcUrl) });
  return {
    async attest(player, method, expiresAt) {
      try {
        const { request } = await client.simulateContract({
          account: referee, address, abi: humanRegistryAbi, functionName: 'attest', args: [player, method, BigInt(expiresAt)],
        });
        const hash = await wallet.writeContract({ ...request, chain: null });
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new Error(`attest reverted (${hash})`);
        return hash;
      } catch (e) {
        throw new Error(revertReason(e));
      }
    },
  };
}
