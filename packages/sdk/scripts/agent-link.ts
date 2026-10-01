/**
 * Run with the AGENT's key to prove its wallet to the operator who owns (or will own) its ERC-8004 agent NFT.
 * Prints JSON to paste into the Profile page ("Link agent wallet" / "Register agent").
 *
 *   PRIVATE_KEY=0x<agent key> OWNER=0x<operator> pnpm agent:link              # next agent id (register + link)
 *   PRIVATE_KEY=0x<agent key> OWNER=0x<operator> AGENT_ID=7 pnpm agent:link   # link to an existing agent
 *
 * SERVER_URL (default http://localhost:8787) supplies the chain id and AgentRegistry address. The proof
 * expires after TTL_SECONDS (default 3600).
 */
import { createPublicClient, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { agentRegistryAbi, signAgentWalletProof, type ServerConfig } from '../src/index.ts';

const env = process.env;
if (!env.PRIVATE_KEY || !env.OWNER) {
  console.error('usage: PRIVATE_KEY=<agent key> OWNER=<operator address> [AGENT_ID=<id>] pnpm agent:link');
  process.exit(1);
}
const server = env.SERVER_URL ?? 'http://localhost:8787';
const config = await (await fetch(`${server}/v1/config`)).json() as ServerConfig;
const registry = config.contracts?.AgentRegistry;
if (!registry) throw new Error(`${server} has no hub contracts (off-chain mode?)`);
let agentId = env.AGENT_ID ? Number(env.AGENT_ID) : NaN;
if (Number.isNaN(agentId)) {
  if (!env.RPC_URL && config.chainId !== 31337) throw new Error('set RPC_URL (or AGENT_ID) so the next agent id can be read');
  const pub = createPublicClient({ transport: http(env.RPC_URL ?? 'http://127.0.0.1:8545') });
  agentId = Number(await pub.readContract({ address: registry, abi: agentRegistryAbi, functionName: 'nextAgentId' }));
}
const proof = await signAgentWalletProof(privateKeyToAccount(env.PRIVATE_KEY as Hex), {
  chainId: config.chainId, registry, agentId, owner: getAddress(env.OWNER), ttlSeconds: Number(env.TTL_SECONDS ?? 3600),
});
console.log(JSON.stringify(proof));
