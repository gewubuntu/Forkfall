/**
 * Publish a season's rewards: standings from on-chain RatingChanged events → allocations → Merkle tree →
 * SeasonRewards.publishSeason. Play free, verify to earn: only verified humans (HumanRegistry) and
 * registered agents (AgentRegistry, ERC-8004) earn; banned wallets never do.
 *
 *   SEASON=1 POOL=1000 pnpm rewards:publish                      # Base Sepolia (REWARDS_ADMIN_PRIVATE_KEY required)
 *   CHAIN_ID=31337 SEASON=1 POOL=1000 FORCE=1 pnpm rewards:publish  # local Anvil (dev key 0)
 *
 * Rule: the pool (tFALL) is split in proportion to settled ranked wins among eligible players.
 * Env: POOL (whole tokens, default 1000), DEADLINE_DAYS (30), START_NEXT=1 (also start the next season),
 *      FORCE=1 (publish a season that is still running), DRY_RUN=1 (write nothing on-chain).
 */
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { agentRegistryAbi, faucetTokenAbi, humanRegistryAbi, matchSettlementAbi, seasonRewardsAbi } from '@forkfall/sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, formatUnits, http, parseUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ANVIL, BASE_SEPOLIA, DEFAULT_RPC, type AddressBook } from '../src/chain.ts';
import { rewardsDir, type RewardsFile } from '../src/rewards.ts';

const env = process.env;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const chainId = Number(env.CHAIN_ID ?? BASE_SEPOLIA);
const bookFile = env.DEPLOYMENTS_FILE ?? join(root, 'contracts/deployments', `${chainId}.json`);
if (!existsSync(bookFile)) throw new Error(`no address book at ${bookFile}`);
const book = JSON.parse(readFileSync(bookFile, 'utf8')) as AddressBook & Record<string, Address>;
const rpcUrl = env.RPC_URL ?? DEFAULT_RPC[chainId];
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const key = (env.REWARDS_ADMIN_PRIVATE_KEY ?? (chainId === ANVIL ? ANVIL_KEY : undefined)) as Hex | undefined;
if (!key && !env.DRY_RUN) throw new Error('set REWARDS_ADMIN_PRIVATE_KEY (the deployer/admin key: REWARDS_ADMIN_ROLE and tFALL owner)');
if (!env.SEASON) throw new Error('set SEASON');
const season = Number(env.SEASON);

const pub = createPublicClient({ transport: http(rpcUrl) });
const S = book.MatchSettlement;
const current = Number(await pub.readContract({ address: S, abi: matchSettlementAbi, functionName: 'currentSeason' }));
if (season >= current && !env.FORCE) throw new Error(`season ${season} is still running (current ${current}); start the next season first or pass FORCE=1`);

// 1. Everyone with a rated result this season, from RatingChanged(season indexed, player indexed).
const latest = await pub.getBlockNumber();
const from = BigInt(book.deployedAtBlock ?? 0);
const players = new Set<Address>();
for (let b = from; b <= latest; b += 9_000n) {
  const logs = await pub.getContractEvents({
    address: S, abi: matchSettlementAbi, eventName: 'RatingChanged', args: { season },
    fromBlock: b, toBlock: b + 8_999n > latest ? latest : b + 8_999n,
  });
  for (const l of logs) players.add(l.args.player as Address);
}

// 2. Records and eligibility.
type Row = { address: Address; rating: number; wins: number; losses: number; draws: number; agent: boolean; human: boolean; banned: boolean };
const rows: Row[] = [];
for (const address of players) {
  const [st, agent, human, banned] = await Promise.all([
    pub.readContract({ address: S, abi: matchSettlementAbi, functionName: 'stats', args: [season, address] }),
    pub.readContract({ address: book.AgentRegistry, abi: agentRegistryAbi, functionName: 'isAgent', args: [address] }),
    pub.readContract({ address: book.HumanRegistry, abi: humanRegistryAbi, functionName: 'isVerifiedHuman', args: [address] }),
    pub.readContract({ address: book.AgentRegistry, abi: agentRegistryAbi, functionName: 'bannedFromRanked', args: [address] }),
  ]);
  rows.push({ address, rating: Number(st.rating), wins: Number(st.wins), losses: Number(st.losses), draws: Number(st.draws), agent, human, banned });
}

// 3. Split the pool by wins among eligible players; rounding dust goes to the top earner.
const token = book.TestFALL;
const decimals = Number(await pub.readContract({ address: token, abi: faucetTokenAbi, functionName: 'decimals' }));
const symbol = await pub.readContract({ address: token, abi: faucetTokenAbi, functionName: 'symbol' });
const pool = parseUnits(String(env.POOL ?? 1000), decimals);
const excluded: RewardsFile['excluded'] = [];
const eligible = rows.filter((r) => {
  const reason = r.banned ? 'banned' : !(r.agent || r.human) ? 'unverified' : r.wins === 0 ? 'no-wins' : null;
  if (reason) excluded.push({ address: r.address, reason, rating: r.rating, wins: r.wins });
  return !reason;
}).sort((a, b) => b.wins - a.wins || b.rating - a.rating);
const totalWins = eligible.reduce((n, r) => n + r.wins, 0);
const amounts = eligible.map((r) => (pool * BigInt(r.wins)) / BigInt(Math.max(1, totalWins)));
if (amounts.length) amounts[0] += pool - amounts.reduce((a, b) => a + b, 0n);
const allocations: RewardsFile['allocations'] = eligible.map((r, i) => ({
  address: r.address, amount: amounts[i].toString(), kind: r.agent ? 'agent' : 'human', rating: r.rating, wins: r.wins, losses: r.losses, draws: r.draws,
}));
if (!allocations.length) throw new Error(`nobody is eligible for season ${season} (${rows.length} rated players, all unverified, banned or winless)`);

const tree = StandardMerkleTree.of(allocations.map((a) => [a.address, a.amount] as [string, string]), ['address', 'uint256']);
const deadline = Math.floor(Date.now() / 1000) + Number(env.DEADLINE_DAYS ?? 30) * 86_400;
const file: RewardsFile = {
  season, chainId, token, tokenSymbol: symbol, tokenDecimals: decimals, root: tree.root as Hex, deadline,
  total: pool.toString(), rule: `Pool split by settled ranked wins among verified humans and registered agents`,
  publishedAt: Math.floor(Date.now() / 1000), allocations, excluded, tree: tree.dump(),
};
console.log(`season ${season}: ${rows.length} rated players, ${allocations.length} eligible, ${excluded.length} excluded`);
for (const a of allocations) console.log(`  ${a.address} ${a.kind.padEnd(5)} ${a.wins}W → ${formatUnits(BigInt(a.amount), decimals)} ${symbol}`);
for (const x of excluded) console.log(`  ${x.address} excluded: ${x.reason}`);

// 4. Fund and publish.
if (!env.DRY_RUN) {
  const account = privateKeyToAccount(key!);
  const wallet = createWalletClient({ account, transport: http(rpcUrl) });
  const send = async (label: string, req: Parameters<typeof wallet.writeContract>[0]) => {
    const hash = await wallet.writeContract({ ...req, chain: null } as never);
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error(`${label} reverted (${hash})`);
    console.log(`  ${label}: ${hash}`);
    return hash;
  };
  await send('fund pool', { address: token, abi: faucetTokenAbi, functionName: 'mint', args: [book.SeasonRewards, pool] } as never);
  file.tx = await send('publishSeason', {
    address: book.SeasonRewards, abi: seasonRewardsAbi, functionName: 'publishSeason', args: [season, file.root, token, BigInt(deadline)],
  } as never);
  if (env.START_NEXT && season >= current) {
    await send(`startSeason(${season + 1})`, { address: S, abi: matchSettlementAbi, functionName: 'startSeason', args: [season + 1] } as never);
  }
}
const dir = env.REWARDS_DIR ?? rewardsDir(root, chainId);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `season-${season}.json`), JSON.stringify(file, null, 2));
console.log(`wrote ${join(dir, `season-${season}.json`)}${env.DRY_RUN ? ' (dry run: nothing published on-chain)' : ''}`);
