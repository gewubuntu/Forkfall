/**
 * Fund an agent's Agent League balance (prepaid entry fees, 0.50 tUSDC per match on the default league).
 * Run with the agent's key; on testnet it taps the tUSDC faucet first if the wallet is short.
 *
 *   PRIVATE_KEY=0x<agent key> AMOUNT=5 pnpm league:deposit
 *
 * SERVER_URL (default http://localhost:8787) supplies the contracts; RPC_URL defaults to local Anvil.
 */
import { createPublicClient, createWalletClient, formatUnits, http, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { agentLeagueAbi, faucetTokenAbi, type ServerConfig } from '../src/index.ts';

const env = process.env;
if (!env.PRIVATE_KEY) { console.error('usage: PRIVATE_KEY=<agent key> [AMOUNT=5] pnpm league:deposit'); process.exit(1); }
const server = env.SERVER_URL ?? 'http://localhost:8787';
const config = await (await fetch(`${server}/v1/config`)).json() as ServerConfig;
const league = config.contracts?.AgentLeague;
const usdc = config.contracts?.TestUSDC;
if (!league || !usdc) throw new Error(`${server} has no AgentLeague (deploy the hub with the league first)`);
const account = privateKeyToAccount(env.PRIVATE_KEY as Hex);
const transport = http(env.RPC_URL ?? 'http://127.0.0.1:8545');
const pub = createPublicClient({ transport });
const wallet = createWalletClient({ account, transport });
const amount = parseUnits(String(env.AMOUNT ?? 5), 6);
const send = async (label: string, req: object) => {
  const hash = await wallet.writeContract({ ...req, chain: null } as never);
  if ((await pub.waitForTransactionReceipt({ hash })).status !== 'success') throw new Error(`${label} reverted`);
  console.log(`  ${label}: ${hash}`);
};
const have = await pub.readContract({ address: usdc, abi: faucetTokenAbi, functionName: 'balanceOf', args: [account.address] });
if (have < amount) await send('faucet drip (tUSDC)', { address: usdc, abi: faucetTokenAbi, functionName: 'drip' });
await send('approve', { address: usdc, abi: faucetTokenAbi, functionName: 'approve', args: [league, amount] });
await send(`deposit ${formatUnits(amount, 6)} tUSDC`, { address: league, abi: agentLeagueAbi, functionName: 'deposit', args: [amount] });
const bal = await pub.readContract({ address: league, abi: agentLeagueAbi, functionName: 'balanceOf', args: [account.address] });
console.log(`league balance of ${account.address}: ${formatUnits(bal, 6)} tUSDC`);
