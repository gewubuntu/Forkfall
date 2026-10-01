import { readFileSync, existsSync } from 'node:fs';
import { createPublicClient, http, parseAbi, type Address, type Hex, type PublicClient } from 'viem';

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
  [k: string]: unknown;
}

const deckAbi = parseAbi([
  'function isValidFor(bytes32 deckId, address player, bool ranked) view returns (bool)',
  'function getDeck(bytes32 deckId) view returns ((address owner, uint8 race, uint16 rarityPoints, uint8 legendaries, uint16[] cardIds))',
]);
const agentAbi = parseAbi([
  'function isAgent(address) view returns (bool)',
  'function bannedFromRanked(address) view returns (bool)',
]);
const humanAbi = parseAbi(['function isVerifiedHuman(address) view returns (bool)']);
const settlementAbi = parseAbi([
  'function currentSeason() view returns (uint32)',
  'function REFEREE_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
]);

export interface Preflight { ok: boolean; errors: string[]; warnings: string[]; notes: string[] }

/**
 * Read-only view of the on-chain hub. Optional: without an RPC the server runs fully off-chain
 * (casual play, dev) and ranked checks fall back to engine-side deck validation.
 */
export class Chain {
  readonly client?: PublicClient;
  /**
   * @param book address book from contracts/deployments/<chainId>.json (null = not deployed / off-chain)
   * @param rpcUrl enables on-chain checks; ignored without a book
   * @param hubChainId chain the server signs for when running without a book (off-chain mode)
   */
  constructor(readonly book: AddressBook | null, rpcUrl?: string, readonly hubChainId = ANVIL) {
    const id = book?.chainId ?? hubChainId;
    if (!TESTNETS.has(id)) throw new Error(`chain ${id} is not an allowed testnet`);
    if (book && rpcUrl) this.client = createPublicClient({ transport: http(rpcUrl) }) as PublicClient;
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
      const role = await this.client.readContract({ address: this.book.MatchSettlement, abi: settlementAbi, functionName: 'REFEREE_ROLE' });
      const isRef = await this.client.readContract({ address: this.book.MatchSettlement, abi: settlementAbi, functionName: 'hasRole', args: [role, referee] });
      if (!isRef) r.errors.push(`referee ${referee} lacks REFEREE_ROLE: ranked results could not settle. Use the REFEREE_ADDRESS key from deployment as HOUSE_PRIVATE_KEY.`);
      const season = await this.season();
      r.notes.push(`season ${season}`);
    }
    const bal = await this.client.getBalance({ address: referee }).catch(() => 0n);
    if (bal === 0n) r.warnings.push(`referee ${referee} has no ETH: it can co-sign results, but cannot submit dispute settlements (settleByReferee) itself`);
    r.ok = r.errors.length === 0;
    return r;
  }
  get settlement(): Address { return this.book?.MatchSettlement ?? '0x0000000000000000000000000000000000000000'; }

  async isAgent(a: Address) {
    if (!this.client) return false;
    return this.client.readContract({ address: this.book!.AgentRegistry, abi: agentAbi, functionName: 'isAgent', args: [a] });
  }
  async isBanned(a: Address) {
    if (!this.client) return false;
    return this.client.readContract({ address: this.book!.AgentRegistry, abi: agentAbi, functionName: 'bannedFromRanked', args: [a] });
  }
  async isHuman(a: Address) {
    if (!this.client) return false;
    return this.client.readContract({ address: this.book!.HumanRegistry, abi: humanAbi, functionName: 'isVerifiedHuman', args: [a] });
  }
  async season(): Promise<number> {
    if (!this.client) return 1;
    return Number(await this.client.readContract({ address: this.book!.MatchSettlement, abi: settlementAbi, functionName: 'currentSeason' }));
  }
  async deck(deckId: Hex, player: Address, ranked: boolean): Promise<{ race: number; cardIds: number[] } | null> {
    if (!this.client) return null;
    const ok = await this.client.readContract({ address: this.book!.DeckRegistry, abi: deckAbi, functionName: 'isValidFor', args: [deckId, player, ranked] });
    if (!ok) return null;
    const d = await this.client.readContract({ address: this.book!.DeckRegistry, abi: deckAbi, functionName: 'getDeck', args: [deckId] });
    return { race: d.race, cardIds: d.cardIds.map(Number) };
  }
}
