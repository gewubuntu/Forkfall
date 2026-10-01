import { keccak256, stringToHex, type Address, type Hex, type LocalAccount } from 'viem';

/** ERC-8004 registration file (the JSON an agentURI resolves to). */
export interface AgentRegistrationFile {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
  name: string;
  description: string;
  image: string;
  services: { name: string; endpoint: string; version?: string }[];
  active: boolean;
  registrations: { agentId: number; agentRegistry: string }[];
  supportedTrust: string[];
  [k: string]: unknown;
}

export const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1' as const;

export function buildAgentRegistration(p: {
  name: string; description?: string; image?: string; mcp?: string; web?: string;
  agentId: number; chainId: number; registry: Address;
}): AgentRegistrationFile {
  const services: AgentRegistrationFile['services'] = [];
  if (p.web) services.push({ name: 'web', endpoint: p.web });
  if (p.mcp) services.push({ name: 'MCP', endpoint: p.mcp });
  return {
    type: REGISTRATION_TYPE,
    name: p.name,
    description: p.description ?? '',
    image: p.image ?? '',
    services,
    active: true,
    registrations: [{ agentId: p.agentId, agentRegistry: `eip155:${p.chainId}:${p.registry}` }],
    supportedTrust: [],
  };
}

/** Fully on-chain agentURI: base64 data URI of the registration file (ERC-8004 recommends this over raw JSON). */
export function agentURIFromFile(file: AgentRegistrationFile): string {
  const bytes = new TextEncoder().encode(JSON.stringify(file));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:application/json;base64,${btoa(bin)}`;
}

/** Decodes a data: agentURI; returns null for ipfs:// / https:// URIs (fetch those yourself) or bad JSON. */
export function parseAgentURI(uri: string): AgentRegistrationFile | null {
  const m = /^data:application\/json(?:;charset=[^;,]+)?(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  try {
    const text = m[1] ? new TextDecoder().decode(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))) : decodeURIComponent(m[2]);
    const j = JSON.parse(text);
    return j && typeof j === 'object' ? (j as AgentRegistrationFile) : null;
  } catch { return null; }
}

/** EIP-712 proof that `wallet` agrees to be agent `agentId`'s agentWallet (AgentRegistry.setAgentWallet). */
export const AGENT_WALLET_TYPES = {
  AgentWalletSet: [
    { name: 'agentId', type: 'uint256' },
    { name: 'newWallet', type: 'address' },
    { name: 'owner', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export function agentWalletDomain(chainId: number, registry: Address) {
  return { name: 'Forkfall AgentRegistry', version: '1', chainId, verifyingContract: registry } as const;
}

/** What an agent hands its operator so the operator can link (or register) it: paste-able JSON. */
export interface AgentWalletProof { agentId: number; wallet: Address; owner: Address; deadline: number; signature: Hex }

export async function signAgentWalletProof(agent: LocalAccount, p: {
  chainId: number; registry: Address; agentId: number; owner: Address; ttlSeconds?: number;
}): Promise<AgentWalletProof> {
  const deadline = Math.floor(Date.now() / 1000) + (p.ttlSeconds ?? 3600);
  const signature = await agent.signTypedData({
    domain: agentWalletDomain(p.chainId, p.registry), types: AGENT_WALLET_TYPES, primaryType: 'AgentWalletSet',
    message: { agentId: BigInt(p.agentId), newWallet: agent.address, owner: p.owner, deadline: BigInt(deadline) },
  });
  return { agentId: p.agentId, wallet: agent.address, owner: p.owner, deadline, signature };
}

/** HumanRegistry method ids are keccak256 of a label. */
export const HUMAN_METHODS = ['testnet', 'passport', 'coinbase', 'worldid', 'self'] as const;
export type HumanMethod = (typeof HUMAN_METHODS)[number];
export const humanMethodId = (m: HumanMethod): Hex => keccak256(stringToHex(m));
export function humanMethodName(id: Hex): HumanMethod | null {
  return HUMAN_METHODS.find((m) => humanMethodId(m) === id) ?? null;
}
