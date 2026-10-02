import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, nonceManager, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { ANVIL, BASE_SEPOLIA, Chain, DEFAULT_RPC, EXPLORER, humanAttestor, leagueOps, questRewarder, refereeSettler } from './chain.ts';
import { LeaguePayouts, leagueDir } from './league.ts';
import { HumanVerification } from './humans.ts';
import { Rewards, rewardsDir } from './rewards.ts';
import { Profiles, profilesFile } from './profiles.ts';
import { finishedMatch, Quests, questsFile } from './quests.ts';
import { createApi } from './http.ts';
import { Lobby, type ArchivedMatch } from './lobby.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const env = process.env;

/**
 * Hub chain: Base Sepolia by default. Modes:
 *   on-chain  (default)  needs contracts/deployments/<CHAIN_ID>.json + RPC; verifies decks, agents, humans, smart wallets
 *   OFFCHAIN=1           no deployment needed; signs for CHAIN_ID but skips every on-chain check (UI dev, casual play)
 * Local: CHAIN_ID=31337 (anvil), see `pnpm server:local`.
 */
const chainId = Number(env.CHAIN_ID ?? BASE_SEPOLIA);
const offchain = env.OFFCHAIN === '1';
const bookFile = env.DEPLOYMENTS_FILE ?? join(root, 'contracts/deployments', `${chainId}.json`);
const rpcUrl = env.RPC_URL ?? DEFAULT_RPC[chainId];

function fail(lines: string[]): never {
  console.error(['', 'Forkfall referee cannot start:', ...lines.map((l) => `  ${l}`), ''].join('\n'));
  process.exit(1);
}

if (!offchain && !existsSync(bookFile)) {
  fail([
    `no address book at ${bookFile}`,
    chainId === BASE_SEPOLIA
      ? 'Deploy the hub first: `pnpm deploy:base-sepolia` (see README "Deploying to Base Sepolia"),'
      : `Deploy to chain ${chainId} first,`,
    'or run without contracts for UI work: `OFFCHAIN=1 pnpm server`.',
  ]);
}
if (!offchain && !rpcUrl) fail([`set RPC_URL for chain ${chainId}`]);
if (!offchain && !env.HOUSE_PRIVATE_KEY && chainId !== ANVIL) {
  fail([
    'HOUSE_PRIVATE_KEY is required: it is the referee key (REFEREE_ROLE) that co-signs ranked results.',
    'Use the key whose address you passed as REFEREE_ADDRESS when deploying.',
  ]);
}

const chain = offchain ? new Chain(null, undefined, chainId) : Chain.load(bookFile, rpcUrl, chainId);
const houseKey = (env.HOUSE_PRIVATE_KEY as Hex | undefined) ?? generatePrivateKey();
// One nonce manager for every referee write (settlement, league starts, attestations, quest payouts), so
// concurrent transactions from the same key never collide on a nonce.
const house = privateKeyToAccount(houseKey, { nonceManager });
const settlementDir = env.SETTLEMENT_DIR ?? join(root, 'contracts/settlements');
const archiveDir = env.MATCH_ARCHIVE_DIR ?? join(root, 'apps/server/data', String(chainId));

if (chain.online) {
  const pf = await chain.preflight(house.address);
  for (const w of pf.warnings) console.warn(`  warning: ${w}`);
  if (!pf.ok) fail(pf.errors);
}

// The referee settles results the loser never signed (AUTO_SETTLE=0 turns it off; it needs testnet ETH).
const settler = chain.online && env.AUTO_SETTLE !== '0' ? refereeSettler(chain, house) : null;

// Agent League (paid agents-only queue): the referee charges entry fees on-chain when a match starts.
const league = chain.online ? leagueOps(chain, house) : null;

// Player profiles: tutorial completion and equipped cosmetics (unlocks checked against on-chain balances).
const profiles = new Profiles(env.PROFILES_FILE ?? profilesFile(root, chainId), (a) => chain.ownedCounts(a));

// Daily quests: progress from finished matches, Scrap and free-pack payouts through QuestRewards (needs testnet ETH).
let quests: Quests;
try {
  quests = new Quests({
    file: env.QUESTS_FILE ?? questsFile(root, chainId),
    rewarder: chain.online ? questRewarder(chain, house) : null,
    chainId,
    periodDays: env.QUEST_PACK_DAYS ? Number(env.QUEST_PACK_DAYS) : undefined,
    packGoal: env.QUEST_PACK_GOAL ? Number(env.QUEST_PACK_GOAL) : undefined,
    packKind: env.QUEST_PACK_KIND ? Number(env.QUEST_PACK_KIND) : undefined,
    // Like season rewards: verified humans and registered agents, not banned. Others' rewards wait until they qualify.
    eligible: chain.online
      ? async (a) => !(await chain.isBanned(a)) && ((await chain.isHuman(a)) || (await chain.isAgent(a)))
      : undefined,
  });
} catch (e) { fail([(e as Error).message, 'Check QUEST_PACK_DAYS, QUEST_PACK_GOAL and QUEST_PACK_KIND.']); }

const lobby = new Lobby({
  chain,
  profiles,
  house,
  settler,
  league,
  turnSeconds: Number(env.TURN_SECONDS ?? 45),
  bankSeconds: Number(env.BANK_SECONDS ?? 60),
  resultGraceSeconds: Number(env.RESULT_GRACE_SECONDS ?? 600),
});

// Finished matches (log + signatures) are archived so history, replays and settlement survive a restart.
let restored = 0;
if (existsSync(archiveDir)) {
  for (const f of readdirSync(archiveDir).filter((x) => x.endsWith('.json'))) {
    try { if (lobby.restore(JSON.parse(readFileSync(join(archiveDir, f), 'utf8')) as ArchivedMatch)) restored++; } catch (e) {
      console.warn(`  skipping archived match ${f}: ${(e as Error).message}`);
    }
  }
}

// Export a Foundry-ready settlement file as soon as a match has enough signatures.
lobby.onChange = (m) => {
  if (m.phase !== 'ended') return;
  try {
    const f = finishedMatch(m);
    if (f) quests.record(f);
  } catch (e) { console.error('quest tracking failed', e); }
  try {
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, `${m.id}.json`), JSON.stringify(lobby.archive(m.id)));
  } catch (e) { console.error('archive failed', e); }
  try {
    const s = lobby.settlement(m.id);
    mkdirSync(settlementDir, { recursive: true });
    writeFileSync(join(settlementDir, `${m.id}.json`), JSON.stringify(s, null, 2));
  } catch { /* not settleable yet */ }
};

setInterval(() => lobby.tick(), 1000);
const botLoop = async () => {
  try { await lobby.stepBots(); } catch (e) { console.error('bot error', e); }
  setTimeout(botLoop, Number(env.BOT_DELAY_MS ?? 600));
};
botLoop();

const settleLoop = async () => {
  try {
    const r = await lobby.settleDue();
    for (const id of r.settled) console.log(`referee settled ${id}`);
    for (const f of r.failed) console.warn(`referee could not settle ${f.matchId}: ${f.error}`);
  } catch (e) { console.error('settle loop error', e); }
  setTimeout(settleLoop, Number(env.SETTLE_INTERVAL_MS ?? 5000));
};
if (settler) settleLoop();

const questLoop = async () => {
  try {
    const r = await quests.payDue();
    for (const p of r.paid) console.log(`quest reward paid to ${p.address}: ${p.scrap ? `${p.scrap} Scrap` : `${p.packs} pack`} (${p.ref}) ${p.tx ?? ''}`);
    for (const p of r.failed) console.warn(`quest reward for ${p.address} (${p.ref}) will retry: ${p.error}`);
  } catch (e) { console.error('quest payout loop error', e); }
  setTimeout(questLoop, Number(env.QUEST_PAY_INTERVAL_MS ?? 5000));
};
if (quests.paysOnChain) questLoop();

const staticDir = join(root, 'apps/web/dist');
// Human verification (optional; gates season rewards) and published season rewards.
const humans = new HumanVerification(chain, chain.online ? humanAttestor(chain, house) : null, { testnet: env.HUMAN_TESTNET_VERIFY !== '0' });
const rewards = new Rewards(env.REWARDS_DIR ?? rewardsDir(root, chain.chainId));
const { server } = createApi(lobby, { staticDir: existsSync(staticDir) ? staticDir : undefined, humans, rewards, profiles, quests, publicUrl: env.PUBLIC_URL, payouts: new LeaguePayouts(env.LEAGUE_DIR ?? leagueDir(root, chain.chainId)) });
const port = Number(env.PORT ?? 8787);
server.listen(port, () => {
  console.log(`Forkfall referee listening on http://localhost:${port}`);
  const name = chain.chainId === BASE_SEPOLIA ? 'Base Sepolia' : chain.chainId === ANVIL ? 'local Anvil' : `chain ${chain.chainId}`;
  console.log(`  hub: ${name} (${chain.chainId}) · ${chain.online ? `on-chain checks ON via ${rpcUrl}` : 'OFF-CHAIN mode: no deck/agent/human checks, results cannot settle'}`);
  if (chain.book) {
    const ex = EXPLORER[chain.chainId];
    console.log(`  MatchSettlement ${chain.settlement}${ex ? `  ${ex}/address/${chain.settlement}` : ''}`);
  }
  console.log(`  house bot / referee address ${house.address}${env.HOUSE_PRIVATE_KEY ? '' : ' (ephemeral key)'}`);
  console.log(`  human verification: ${humans.verifiers.filter((v) => v.available).map((v) => v.id).join(', ') || 'none'}${chain.online ? '' : ' (off-chain: status only)'}`);
  console.log(`  Agent League: ${league ? `ON (${chain.book!.AgentLeague})` : 'off (no AgentLeague in the address book)'}`);
  console.log(`  daily quests: ${quests.paysOnChain ? 'rewards paid on-chain via QuestRewards' : 'progress only (no QuestRewards: rewards not paid)'} · free pack every ${quests.periodDays} days for ${quests.packGoal} quests`);
  console.log(`  referee auto-settlement ${settler ? `ON (after ${lobby.graceMs / 1000}s grace, instantly on timeout/concede)` : 'OFF'}`);
  console.log(`  settlement files → ${settlementDir}`);
  console.log(`  match archive → ${archiveDir} (${restored} restored)`);
});
