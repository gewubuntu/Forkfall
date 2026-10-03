import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, nonceManager, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { ANVIL, BASE_SEPOLIA, Chain, DEFAULT_RPC, devVrfFulfiller, EXPLORER, humanAttestor, leagueOps, questRewarder, refereeSettler } from './chain.ts';
import { LeaguePayouts, leagueDir } from './league.ts';
import { HumanVerification } from './humans.ts';
import { Rewards, rewardsDir } from './rewards.ts';
import { Profiles, profilesFile } from './profiles.ts';
import { finishedMatch, Quests, questsFile } from './quests.ts';
import { createApi } from './http.ts';
import { Lobby, type ArchivedMatch, type SavedLobby, type SavedMatch } from './lobby.ts';
import { StateStore } from './state.ts';

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
// Running matches, the queue, challenges and login sessions, so a restart or redeploy doesn't drop live games.
const stateDir = env.STATE_DIR ?? join(archiveDir, 'state');
const store = env.PERSIST_STATE === '0' ? null : new StateStore(stateDir);

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
  store,
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

// Then everything that was still running: matches (replayed move by move), the queue and challenges.
let resumed = 0;
if (store) {
  const saved = store.read<SavedLobby>('lobby.json');
  const downSince = saved?.aliveAt ?? 0;
  if (saved) lobby.restoreLobby(saved);
  for (const f of store.list('matches')) {
    const rec = store.read<SavedMatch>(f);
    if (rec && lobby.restoreRunning(rec, downSince)) resumed++;
    else { console.warn(`  could not resume ${f}; moved aside`); try { store.write(`${f}.bad`, rec); store.remove(f); } catch { /* keep going */ } }
  }
}
let lastLobby = '';
let lastAlive = 0;
/** Write the queue and challenges when they changed, and a heartbeat every few seconds (to measure downtime). */
const flushLobby = (force = false) => {
  if (!store) return;
  const s = lobby.saveLobby();
  const body = JSON.stringify({ ...s, aliveAt: 0 });
  if (!force && body === lastLobby && Date.now() - lastAlive < 5000) return;
  try { store.write('lobby.json', s); lastLobby = body; lastAlive = Date.now(); } catch (e) { console.error('could not save lobby state', e); }
};

// Export a Foundry-ready settlement file as soon as a match has enough signatures.
lobby.onChange = (m) => {
  if (m.phase !== 'ended') return;
  try {
    const f = finishedMatch(m);
    if (f) {
      const fresh = !quests.hasSeen(f.id);
      quests.record(f);
      // Notify once, when the match first counts (onChange also fires for every later signature/settlement step).
      if (fresh && quests.hasSeen(f.id)) for (const p of f.players) if (!p.bot) lobby.bus?.user(p.address, 'quests');
    }
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

setInterval(() => { lobby.tick(); flushLobby(); }, 1000);
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
    for (const p of [...r.paid, ...r.failed]) lobby.bus?.user(p.address, 'quests');
    for (const p of r.paid) console.log(`quest reward paid to ${p.address}: ${p.scrap ? `${p.scrap} Scrap` : `${p.packs} pack`} (${p.ref}) ${p.tx ?? ''}`);
    for (const p of r.failed) console.warn(`quest reward for ${p.address} (${p.ref}) will retry: ${p.error}`);
  } catch (e) { console.error('quest payout loop error', e); }
  setTimeout(questLoop, Number(env.QUEST_PAY_INTERVAL_MS ?? 5000));
};
if (quests.paysOnChain) questLoop();

// Local Anvil: play the part of Chainlink's VRF nodes for the mock coordinator, so packs open like on a testnet.
const vrfFulfill = devVrfFulfiller(chain, house);
const vrfLoop = async () => {
  try { const tx = await vrfFulfill!(); if (tx) console.log(`dev VRF: fulfilled pack randomness ${tx}`); } catch (e) { console.warn('dev VRF fulfill failed', (e as Error).message); }
  setTimeout(vrfLoop, Number(env.DEV_VRF_INTERVAL_MS ?? 2000));
};
if (vrfFulfill) vrfLoop();

const staticDir = join(root, 'apps/web/dist');
// Human verification (optional; gates season rewards) and published season rewards.
const humans = new HumanVerification(chain, chain.online ? humanAttestor(chain, house) : null, { testnet: env.HUMAN_TESTNET_VERIFY !== '0' });
const rewards = new Rewards(env.REWARDS_DIR ?? rewardsDir(root, chain.chainId));
const { server, live } = createApi(lobby, { staticDir: existsSync(staticDir) ? staticDir : undefined, humans, rewards, profiles, quests, publicUrl: env.PUBLIC_URL, payouts: new LeaguePayouts(env.LEAGUE_DIR ?? leagueDir(root, chain.chainId)), store });

// Stop cleanly on a redeploy: save the queue and challenges (matches and sessions are saved as they change).
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    flushLobby(true);
    console.log(`${sig}: state saved, shutting down`);
    live.close(); // clients reconnect to the next instance on their own
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
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
  if (vrfFulfill) console.log('  pack randomness: local mock VRF coordinator, fulfilled by this server every 2 s');
  console.log('  live updates: WebSocket on /v1/live (clients fall back to polling without it)');
  console.log(`  daily quests: ${quests.paysOnChain ? 'rewards paid on-chain via QuestRewards' : 'progress only (no QuestRewards: rewards not paid)'} · free pack every ${quests.periodDays} days for ${quests.packGoal} quests`);
  console.log(`  referee auto-settlement ${settler ? `ON (after ${lobby.graceMs / 1000}s grace, instantly on timeout/concede)` : 'OFF'}`);
  console.log(`  settlement files → ${settlementDir}`);
  console.log(`  match archive → ${archiveDir} (${restored} restored)`);
  console.log(store ? `  running state → ${stateDir} (${resumed} running match${resumed === 1 ? '' : 'es'} resumed)` : '  running state: memory only (PERSIST_STATE=0)');
});
