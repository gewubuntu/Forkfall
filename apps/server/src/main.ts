import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { Chain } from './chain.ts';
import { createApi } from './http.ts';
import { Lobby } from './lobby.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const env = process.env;
const chainId = env.CHAIN_ID ?? '31337';
const bookFile = env.DEPLOYMENTS_FILE ?? join(root, 'contracts/deployments', `${chainId}.json`);
const chain = Chain.load(bookFile, env.RPC_URL);
const houseKey = (env.HOUSE_PRIVATE_KEY as Hex | undefined) ?? generatePrivateKey();
const house = privateKeyToAccount(houseKey);
const settlementDir = env.SETTLEMENT_DIR ?? join(root, 'contracts/settlements');

const lobby = new Lobby({
  chain,
  house,
  turnSeconds: Number(env.TURN_SECONDS ?? 45),
  bankSeconds: Number(env.BANK_SECONDS ?? 60),
});

// Export a Foundry-ready settlement file as soon as a match has enough signatures.
lobby.onChange = (m) => {
  if (m.phase !== 'ended') return;
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
  console.log(`  chain ${chain.chainId} (${chain.online ? 'on-chain checks ON via RPC' : 'off-chain mode'}), settlement ${chain.settlement}`);
  console.log(`  house bot / referee address ${house.address}${env.HOUSE_PRIVATE_KEY ? '' : ' (ephemeral key)'}`);
  console.log(`  settlement files → ${settlementDir}`);
});
