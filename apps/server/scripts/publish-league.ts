/**
 * Publish a finished Agent League week: standings from AgentLeague → eligibility → payouts → Merkle root →
 * AgentLeague.publishWeek. Prizes are claimed per agent and paid to its operator.
 *
 *   WEEK=3 pnpm league:publish                         # Base Sepolia (REWARDS_ADMIN_PRIVATE_KEY required)
 *   CHAIN_ID=31337 WEEK=1 pnpm league:publish          # local Anvil (dev key 0)
 *
 * Rule (defaults): eligible = registered, unbanned agents with ≥10 league games against ≥5 different
 * opponents that week. The top half of eligible agents by league rating is paid, weighted linearly by rank
 * (rank 1 gets the most). If nobody is eligible, the pot rolls into the current week.
 * Env: WEEK (default: last finished week), MIN_GAMES (10), MIN_OPPONENTS (5), DEADLINE_DAYS (30), DRY_RUN=1.
 */
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { agentLeagueAbi, agentRegistryAbi } from '@forkfall/sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, formatUnits, http, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ANVIL, BASE_SEPOLIA, DEFAULT_RPC, type AddressBook } from '../src/chain.ts';
import { leagueDir, type LeagueWeekFile } from '../src/league.ts';

const env = process.env;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const chainId = Number(env.CHAIN_ID ?? BASE_SEPOLIA);
const bookFile = env.DEPLOYMENTS_FILE ?? join(root, 'contracts/deployments', `${chainId}.json`);
if (!existsSync(bookFile)) throw new Error(`no address book at ${bookFile}`);
const book = JSON.parse(readFileSync(bookFile, 'utf8')) as AddressBook & Record<string, Address>;
if (!book.AgentLeague) throw new Error('this deployment has no AgentLeague');
const L = book.AgentLeague;
const rpcUrl = env.RPC_URL ?? DEFAULT_RPC[chainId];
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const key = (env.REWARDS_ADMIN_PRIVATE_KEY ?? (chainId === ANVIL ? ANVIL_KEY : undefined)) as Hex | undefined;
if (!key && !env.DRY_RUN) throw new Error('set REWARDS_ADMIN_PRIVATE_KEY (the deployer/admin key: REWARDS_ADMIN_ROLE on AgentLeague)');
const MIN_GAMES = Number(env.MIN_GAMES ?? 10);
const MIN_OPPONENTS = Number(env.MIN_OPPONENTS ?? 5);

const pub = createPublicClient({ transport: http(rpcUrl) });
const read = <T,>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
const current = Number(await read<number>(L, agentLeagueAbi, 'currentWeek'));
const week = Number(env.WEEK ?? current - 1);
if (week < 1 || week >= current) throw new Error(`week ${week} is not finished yet (current week ${current})`);

type S = { games: number; wins: number; losses: number; draws: number; opponents: number; rating: number };
const players = await read<Address[]>(L, agentLeagueAbi, 'players', [week]);
const rows = await Promise.all(players.map(async (agent) => {
  const [s, operator, banned] = await Promise.all([
    read<S>(L, agentLeagueAbi, 'standing', [week, agent]),
    read<Address>(L, agentLeagueAbi, 'operatorOf', [agent]),
    read<boolean>(book.AgentRegistry, agentRegistryAbi, 'bannedFromRanked', [agent]),
  ]);
  return { agent, operator, banned, ...s, rating: Number(s.rating), games: Number(s.games), wins: Number(s.wins), opponents: Number(s.opponents) };
}));

const ineligible: LeagueWeekFile['ineligible'] = [];
const eligible = rows.filter((r) => {
  const reason = /^0x0{40}$/i.test(r.operator) ? 'not-an-agent' : r.banned ? 'banned'
    : r.games < MIN_GAMES ? 'too-few-games' : r.opponents < MIN_OPPONENTS ? 'too-few-opponents' : null;
  if (reason) ineligible.push({ agent: r.agent, reason, games: r.games, opponents: r.opponents });
  return !reason;
}).sort((a, b) => b.rating - a.rating || b.wins - a.wins || b.games - a.games);

const pot = await read<bigint>(L, agentLeagueAbi, 'pot', [week]);
const paidCount = Math.ceil(eligible.length / 2);
for (const r of eligible.slice(paidCount)) ineligible.push({ agent: r.agent, reason: 'below-cut', games: r.games, opponents: r.opponents });
const weights = Array.from({ length: paidCount }, (_, i) => BigInt(paidCount - i));
const totalW = weights.reduce((a, b) => a + b, 0n);
const amounts = weights.map((w) => (totalW ? (pot * w) / totalW : 0n));
if (amounts.length) amounts[0] += pot - amounts.reduce((a, b) => a + b, 0n);
const payouts: LeagueWeekFile['payouts'] = eligible.slice(0, paidCount).map((r, i) => ({
  agent: r.agent, operator: r.operator, amount: amounts[i].toString(), rank: i + 1, rating: r.rating, games: r.games, opponents: r.opponents,
}));

const deadline = Math.floor(Date.now() / 1000) + Number(env.DEADLINE_DAYS ?? 30) * 86_400;
const tree = StandardMerkleTree.of<[string, string]>(payouts.length ? payouts.map((p) => [p.agent, p.amount]) : [[L, '0']], ['address', 'uint256']);
const rootHash = (payouts.length ? tree.root : keccak256(stringToHex(`no payouts for week ${week}`))) as Hex;
const file: LeagueWeekFile = {
  week, chainId, league: L, pot: pot.toString(), root: rootHash, deadline: payouts.length ? deadline : 0,
  rule: `Top half of eligible agents (≥${MIN_GAMES} games, ≥${MIN_OPPONENTS} opponents) by league rating, linear by rank; paid to operators`,
  publishedAt: Math.floor(Date.now() / 1000), payouts, ineligible, tree: tree.dump(),
};
console.log(`week ${week}: pot ${formatUnits(pot, 6)} tUSDC, ${rows.length} agents, ${eligible.length} eligible, ${payouts.length} paid`);
for (const p of payouts) console.log(`  #${p.rank} ${p.agent} (operator ${p.operator}) rating ${p.rating} → ${formatUnits(BigInt(p.amount), 6)} tUSDC`);
for (const x of ineligible) console.log(`  ${x.agent} not paid: ${x.reason} (${x.games} games, ${x.opponents} opponents)`);

if (!env.DRY_RUN) {
  const wallet = createWalletClient({ account: privateKeyToAccount(key!), transport: http(rpcUrl) });
  const send = async (label: string, functionName: string, args: readonly unknown[]) => {
    const hash = await wallet.writeContract({ address: L, abi: agentLeagueAbi, functionName, args, chain: null } as never);
    if ((await pub.waitForTransactionReceipt({ hash })).status !== 'success') throw new Error(`${label} reverted (${hash})`);
    console.log(`  ${label}: ${hash}`);
    return hash;
  };
  if (payouts.length) {
    file.tx = await send('publishWeek', 'publishWeek', [week, rootHash, BigInt(deadline)]);
  } else {
    // Nobody qualified: close the week at once and roll the pot into the current week.
    const now = Number((await pub.getBlock()).timestamp);
    file.tx = await send('publishWeek (no payouts)', 'publishWeek', [week, rootHash, BigInt(now)]);
    if (pot > 0n) {
      while (Number((await pub.getBlock()).timestamp) <= now) await new Promise((r) => setTimeout(r, 1000));
      await send(`rollover → week ${current}`, 'rollover', [week]);
    }
  }
}
const dir = env.LEAGUE_DIR ?? leagueDir(root, chainId);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `week-${week}.json`), JSON.stringify(file, null, 2));
console.log(`wrote ${join(dir, `week-${week}.json`)}${env.DRY_RUN ? ' (dry run: nothing published on-chain)' : ''}`);
