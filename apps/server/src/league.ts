import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';

/**
 * A published Agent League week (written by `pnpm league:publish`): standings, the payout rule and the
 * Merkle tree whose root is in AgentLeague.payoutRoot(week). Prizes are paid to the agents' operators.
 */
export interface LeagueWeekFile {
  week: number;
  chainId: number;
  league: Address;
  pot: string;
  root: Hex;
  deadline: number;
  rule: string;
  publishedAt: number;
  tx?: Hex;
  payouts: { agent: Address; operator: Address; amount: string; rank: number; rating: number; games: number; opponents: number }[];
  ineligible: { agent: Address; reason: 'too-few-games' | 'too-few-opponents' | 'banned' | 'not-an-agent' | 'below-cut'; games: number; opponents: number }[];
  tree: ReturnType<StandardMerkleTree<[string, string]>['dump']>;
}

export interface LeagueClaim { week: number; agent: Address; amount: string; proof: Hex[]; rank: number; deadline: number }

export function leagueDir(root: string, chainId: number) {
  return join(root, 'apps/server/data/league', String(chainId));
}

export class LeaguePayouts {
  private cache: { at: number; files: LeagueWeekFile[] } | null = null;
  constructor(private dir: string) {}

  weeks(): LeagueWeekFile[] {
    if (this.cache && Date.now() - this.cache.at < 10_000) return this.cache.files;
    const files = existsSync(this.dir)
      ? readdirSync(this.dir).filter((f) => /^week-\d+\.json$/.test(f))
        .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as LeagueWeekFile)
        .sort((a, b) => b.week - a.week)
      : [];
    this.cache = { at: Date.now(), files };
    return files;
  }

  /** Claimable prizes for these agents across published weeks (claim on AgentLeague; funds go to the operator). */
  claims(agents: Address[]): LeagueClaim[] {
    const want = new Set(agents.map((a) => a.toLowerCase()));
    const out: LeagueClaim[] = [];
    for (const f of this.weeks()) {
      const tree = StandardMerkleTree.load(f.tree);
      for (const [i, [agent, amount]] of tree.entries()) {
        if (!want.has(agent.toLowerCase())) continue;
        const p = f.payouts.find((x) => x.agent.toLowerCase() === agent.toLowerCase());
        out.push({ week: f.week, agent: agent as Address, amount, proof: tree.getProof(i) as Hex[], rank: p?.rank ?? 0, deadline: f.deadline });
      }
    }
    return out;
  }
}
