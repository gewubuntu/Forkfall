import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { ANVIL, BASE_SEPOLIA, Chain, DEFAULT_RPC, EXPLORER } from './chain.ts';
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
const house = privateKeyToAccount(houseKey);
const settlementDir = env.SETTLEMENT_DIR ?? join(root, 'contracts/settlements');
const archiveDir = env.MATCH_ARCHIVE_DIR ?? join(root, 'apps/server/data', String(chainId));

if (chain.online) {
  const pf = await chain.preflight(house.address);
  for (const w of pf.warnings) console.warn(`  warning: ${w}`);
  if (!pf.ok) fail(pf.errors);
}

const lobby = new Lobby({
  chain,
  house,
  turnSeconds: Number(env.TURN_SECONDS ?? 45),
  bankSeconds: Number(env.BANK_SECONDS ?? 60),
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

const staticDir = join(root, 'apps/web/dist');
const { server } = createApi(lobby, { staticDir: existsSync(staticDir) ? staticDir : undefined });
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
  console.log(`  settlement files → ${settlementDir}`);
  console.log(`  match archive → ${archiveDir} (${restored} restored)`);
});
