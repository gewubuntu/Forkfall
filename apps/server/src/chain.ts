import { readFileSync, existsSync } from 'node:fs';
import { createPublicClient, http, parseAbi, type Address, type Hex, type PublicClient } from 'viem';

const TESTNETS = new Set([31337, 84532, 46630, 11155111]);

export interface AddressBook {
  chainId: number;
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
const settlementAbi = parseAbi(['function currentSeason() view returns (uint32)']);

/**
 * Read-only view of the on-chain hub. Optional: without an RPC the server runs fully off-chain
 * (casual play, dev) and ranked checks fall back to engine-side deck validation.
 */
export class Chain {
  readonly client?: PublicClient;
  constructor(readonly book: AddressBook | null, rpcUrl?: string) {
    if (book && !TESTNETS.has(book.chainId)) throw new Error(`chain ${book.chainId} is not an allowed testnet`);
    if (book && rpcUrl) this.client = createPublicClient({ transport: http(rpcUrl) }) as PublicClient;
  }

  static load(bookFile?: string, rpcUrl?: string): Chain {
    if (!bookFile || !existsSync(bookFile)) return new Chain(null);
    return new Chain(JSON.parse(readFileSync(bookFile, 'utf8')), rpcUrl);
  }

  get online() { return !!this.client; }
  get chainId() { return this.book?.chainId ?? 31337; }
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
