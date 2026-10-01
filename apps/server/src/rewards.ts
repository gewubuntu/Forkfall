import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';

/**
 * A published season: who earned what, and the Merkle tree whose root is in SeasonRewards.
 * Written by `pnpm rewards:publish`; served to players as claimable proofs.
 */
export interface RewardsFile {
  season: number;
  chainId: number;
  token: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  root: Hex;
  /** Unix seconds; 0 = no deadline. */
  deadline: number;
  total: string;
  rule: string;
  publishedAt: number;
  tx?: Hex;
  allocations: { address: Address; amount: string; kind: 'human' | 'agent'; rating: number; wins: number; losses: number; draws: number }[];
  /** Players with ranked results who earned nothing, and why ("verify to earn"). */
  excluded: { address: Address; reason: 'unverified' | 'banned' | 'no-wins'; rating: number; wins: number }[];
  tree: ReturnType<StandardMerkleTree<[string, string]>['dump']>;
}

export interface PlayerReward {
  season: number;
  token: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  deadline: number;
  rule: string;
  /** Present when the player earned something: claim with (season, amount, proof). */
  amount?: string;
  proof?: Hex[];
  kind?: 'human' | 'agent';
  /** Present when the player played ranked but earned nothing. */
  excluded?: 'unverified' | 'banned' | 'no-wins';
}

export function rewardsDir(root: string, chainId: number) {
  return join(root, 'apps/server/data/rewards', String(chainId));
}

export class Rewards {
  private cache: { at: number; files: RewardsFile[] } | null = null;

  constructor(private dir: string) {}

  /** Published seasons, newest first (re-read at most every 10 s, so a publish needs no restart). */
  seasons(): RewardsFile[] {
    if (this.cache && Date.now() - this.cache.at < 10_000) return this.cache.files;
    const files = existsSync(this.dir)
      ? readdirSync(this.dir).filter((f) => /^season-\d+\.json$/.test(f))
        .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as RewardsFile)
        .sort((a, b) => b.season - a.season)
      : [];
    this.cache = { at: Date.now(), files };
    return files;
  }

  forPlayer(player: Address): PlayerReward[] {
    const me = player.toLowerCase();
    const out: PlayerReward[] = [];
    for (const f of this.seasons()) {
      const base = { season: f.season, token: f.token, tokenSymbol: f.tokenSymbol, tokenDecimals: f.tokenDecimals, deadline: f.deadline, rule: f.rule };
      const tree = StandardMerkleTree.load(f.tree);
      let found = false;
      for (const [i, [addr, amount]] of tree.entries()) {
        if (addr.toLowerCase() !== me) continue;
        const a = f.allocations.find((x) => x.address.toLowerCase() === me);
        out.push({ ...base, amount, proof: tree.getProof(i) as Hex[], kind: a?.kind });
        found = true;
        break;
      }
      if (!found) {
        const ex = f.excluded.find((x) => x.address.toLowerCase() === me);
        if (ex) out.push({ ...base, excluded: ex.reason });
      }
    }
    return out;
  }
}
