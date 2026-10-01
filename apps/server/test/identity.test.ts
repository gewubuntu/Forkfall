import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import {
  agentURIFromFile, buildAgentRegistration, humanMethodId, humanMethodName, parseAgentURI, signAgentWalletProof,
  AGENT_WALLET_TYPES, agentWalletDomain,
} from '@forkfall/sdk';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyTypedData, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { Chain } from '../src/chain.ts';
import { HumanVerification } from '../src/humans.ts';
import { Lobby } from '../src/lobby.ts';
import { Rewards, type RewardsFile } from '../src/rewards.ts';

/** Off-chain Chain with scripted registry answers. */
class FakeChain extends Chain {
  agents = new Map<string, number>();
  humans = new Map<string, { method: Hex; verifiedAt: number; expiresAt: number }>();
  constructor() { super(null); }
  override async isAgent(a: Address) { return (this.agents.get(a.toLowerCase()) ?? 0) > 0; }
  override async agentOf(a: Address) { return this.agents.get(a.toLowerCase()) ?? 0; }
  override async humanVerification(a: Address) { return this.humans.get(a.toLowerCase()) ?? null; }
}

const addr = () => privateKeyToAccount(generatePrivateKey()).address;
const commit = ('0x' + '11'.repeat(32)) as Hex;

describe('Human queue', () => {
  it('is open to every non-agent wallet, with no verification', async () => {
    const chain = new FakeChain();
    const lobby = new Lobby({ chain, house: privateKeyToAccount(generatePrivateKey()) });
    const human = addr();
    const bot = addr();
    chain.agents.set(bot.toLowerCase(), 3);
    await expect(lobby.enqueue(human, { mode: 'human', race: 'agents', seedCommit: commit }, false)).resolves.toMatchObject({ status: 'queued' });
    await expect(lobby.enqueue(bot, { mode: 'human', race: 'degens', seedCommit: commit }, false)).rejects.toThrow(/agents cannot join the Human queue/);
    await expect(lobby.enqueue(addr(), { mode: 'human', race: 'degens', seedCommit: commit }, true)).rejects.toThrow(/agents cannot/);
  });
});

describe('human verification', () => {
  function setup() {
    const chain = new FakeChain();
    const calls: { player: Address; method: Hex; expiresAt: number }[] = [];
    const attestor = {
      async attest(player: Address, method: Hex, expiresAt: number) {
        calls.push({ player, method, expiresAt });
        chain.humans.set(player.toLowerCase(), { method, verifiedAt: Math.floor(Date.now() / 1000), expiresAt });
        return ('0x' + 'cd'.repeat(32)) as Hex;
      },
    };
    return { chain, calls, hv: new HumanVerification(chain, attestor) };
  }

  it('attests the testnet method for 30 days and reports the status', async () => {
    const { calls, hv } = setup();
    const me = addr();
    const before = await hv.status(me);
    expect(before.verified).toBe(false);
    expect(before.methods.map((m) => [m.id, m.available])).toEqual([['testnet', true], ['passport', false], ['coinbase', false]]);
    const r = await hv.verify(me, 'testnet', {});
    expect(calls[0].method).toBe(humanMethodId('testnet'));
    expect(calls[0].expiresAt - Math.floor(Date.now() / 1000)).toBeGreaterThan(29 * 86_400);
    expect(r).toMatchObject({ verified: true, method: 'testnet', tx: '0x' + 'cd'.repeat(32) });
  });

  it('refuses agents, unknown and not-yet-connected methods, and works read-only without an attestor', async () => {
    const { chain, calls, hv } = setup();
    const bot = addr();
    chain.agents.set(bot.toLowerCase(), 2);
    await expect(hv.verify(bot, 'testnet', {})).rejects.toThrow(/agents cannot verify/);
    await expect(hv.verify(addr(), 'retina', {})).rejects.toThrow(/unknown verification method/);
    await expect(hv.verify(addr(), 'passport', {})).rejects.toThrow(/not connected/);
    expect(calls).toEqual([]);

    const readOnly = new HumanVerification(new FakeChain(), null);
    expect((await readOnly.status(addr())).methods.every((m) => !m.available)).toBe(true);
    await expect(readOnly.verify(addr(), 'testnet', {})).rejects.toThrow(/cannot write attestations/);
    expect(new HumanVerification(new FakeChain(), null, { testnet: false }).verifiers.map((v) => v.id)).not.toContain('testnet');
  });
});

describe('season rewards', () => {
  it('serves Merkle proofs that verify against the published root, and explains exclusions', () => {
    const [a, b, c] = [addr(), addr(), addr()];
    const tree = StandardMerkleTree.of<[string, string]>([[a, '600'], [b, '400']], ['address', 'uint256']);
    const file: RewardsFile = {
      season: 1, chainId: 31337, token: addr(), tokenSymbol: 'tFALL', tokenDecimals: 18, root: tree.root as Hex, deadline: 0,
      total: '1000', rule: 'by wins', publishedAt: 0, tree: tree.dump(),
      allocations: [
        { address: a, amount: '600', kind: 'human', rating: 1232, wins: 3, losses: 0, draws: 0 },
        { address: b, amount: '400', kind: 'agent', rating: 1216, wins: 2, losses: 1, draws: 0 },
      ],
      excluded: [{ address: c, reason: 'unverified', rating: 1250, wins: 4 }],
    };
    const dir = mkdtempSync(join(tmpdir(), 'rewards-'));
    writeFileSync(join(dir, 'season-1.json'), JSON.stringify(file));
    const rewards = new Rewards(dir);

    const mine = rewards.forPlayer(b);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ season: 1, amount: '400', kind: 'agent' });
    expect(StandardMerkleTree.verify(tree.root, ['address', 'uint256'], [b, '400'], mine[0].proof!)).toBe(true);
    expect(rewards.forPlayer(c)).toEqual([expect.objectContaining({ season: 1, excluded: 'unverified' })]);
    expect(rewards.forPlayer(addr())).toEqual([]);
    expect(new Rewards(join(dir, 'missing')).forPlayer(a)).toEqual([]);
  });
});

describe('ERC-8004 helpers', () => {
  it('round-trips an on-chain registration file and signs the agent wallet proof', async () => {
    const registry = addr();
    const file = buildAgentRegistration({ name: 'Greedy Bot ✓', description: 'Plays Brokers', mcp: 'https://bot.example/mcp', agentId: 7, chainId: 84532, registry });
    const uri = agentURIFromFile(file);
    expect(uri.startsWith('data:application/json;base64,')).toBe(true);
    expect(parseAgentURI(uri)).toEqual(file);
    expect(file.registrations[0].agentRegistry).toBe(`eip155:84532:${registry}`);
    expect(parseAgentURI('ipfs://cid')).toBeNull();

    const agent = privateKeyToAccount(generatePrivateKey());
    const owner = addr();
    const p = await signAgentWalletProof(agent, { chainId: 84532, registry, agentId: 7, owner });
    expect(p).toMatchObject({ agentId: 7, wallet: agent.address, owner });
    expect(await verifyTypedData({
      address: agent.address, signature: p.signature, domain: agentWalletDomain(84532, registry), types: AGENT_WALLET_TYPES,
      primaryType: 'AgentWalletSet', message: { agentId: 7n, newWallet: agent.address, owner, deadline: BigInt(p.deadline) },
    })).toBe(true);
    expect(humanMethodName(humanMethodId('passport'))).toBe('passport');
  });
});
