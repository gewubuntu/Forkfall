import { encodeAbiParameters, getAddress, hashTypedData, isAddress, keccak256, stringToHex, type Address, type Hex, type TypedDataDomain } from 'viem';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';
import type { Action, Seat } from '@forkfall/engine';

/**
 * One protocol for humans and agents. Every move and every result is an EIP-712 message under the
 * same domain as the MatchSettlement contract, so signatures are bound to one chain + deployment.
 */
export function forkfallDomain(chainId: number, verifyingContract: Address): TypedDataDomain {
  return { name: 'Forkfall', version: '1', chainId, verifyingContract };
}

export const MOVE_TYPES = {
  Move: [
    { name: 'matchId', type: 'bytes32' },
    { name: 'seq', type: 'uint32' },
    { name: 'prevHash', type: 'bytes32' },
    { name: 'actionHash', type: 'bytes32' },
  ],
} as const;

export const RESULT_TYPES = {
  MatchResult: [
    { name: 'matchId', type: 'bytes32' },
    { name: 'playerA', type: 'address' },
    { name: 'playerB', type: 'address' },
    { name: 'winner', type: 'address' },
    { name: 'deckA', type: 'bytes32' },
    { name: 'deckB', type: 'bytes32' },
    { name: 'mode', type: 'uint8' },
    { name: 'season', type: 'uint32' },
    { name: 'turns', type: 'uint16' },
    { name: 'logHash', type: 'bytes32' },
  ],
} as const;

export interface MoveMessage { matchId: Hex; seq: number; prevHash: Hex; actionHash: Hex }

export interface MatchResult {
  matchId: Hex;
  playerA: Address;
  playerB: Address;
  winner: Address;
  deckA: Hex;
  deckB: Hex;
  mode: number;
  season: number;
  turns: number;
  logHash: Hex;
}

/** league = Agent League: agents only, paid entry, weekly pot (AgentLeague). */
export const MODES = { casual: 0, ranked: 1, human: 2, league: 3 } as const;
export type Mode = keyof typeof MODES;
export const ZERO32 = ('0x' + '0'.repeat(64)) as Hex;
export const ZERO_ADDRESS = ('0x' + '0'.repeat(40)) as Address;

/** Deterministic JSON (sorted keys) so both sides hash an action identically. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function actionHash(a: Action): Hex {
  return keccak256(stringToHex(canonicalJson(a)));
}

/** Log hash chain: head_n = keccak256(abi.encode(head_{n-1}, seat, actionHash_n)). */
export function nextHead(prev: Hex, seat: Seat, aHash: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint8' }, { type: 'bytes32' }], [prev, seat, aHash]));
}

export function moveDigest(domain: TypedDataDomain, m: MoveMessage): Hex {
  return hashTypedData({ domain, types: MOVE_TYPES, primaryType: 'Move', message: { ...m } });
}

export function resultDigest(domain: TypedDataDomain, r: MatchResult): Hex {
  return hashTypedData({ domain, types: RESULT_TYPES, primaryType: 'MatchResult', message: { ...r } });
}

/** Seed share commitment for the commit-reveal match seed. */
export function commitSeed(share: Hex): Hex {
  return keccak256(share);
}

// ─── Wallet login + session keys ────────────────────────────────
// The wallet signs one SIWE (EIP-4361) message that authorizes an in-browser session key.
// The session key then signs moves without wallet popups; the wallet still signs match results.

/** SIWE resource URI carrying the authorized session key. */
export const SESSION_RESOURCE_PREFIX = 'urn:forkfall:session-key:';
/** Longest session a delegation may authorize. */
export const MAX_SESSION_SECONDS = 24 * 60 * 60;
export const DEFAULT_SESSION_SECONDS = 8 * 60 * 60;

export interface Delegation { message: string; signature: Hex }

export function buildSessionMessage(p: {
  domain: string;
  uri: string;
  wallet: Address;
  sessionKey: Address;
  chainId: number;
  nonce: string;
  issuedAt?: Date;
  expiresAt: Date;
}): string {
  return createSiweMessage({
    domain: p.domain,
    uri: p.uri,
    address: p.wallet,
    chainId: p.chainId,
    nonce: p.nonce,
    version: '1',
    issuedAt: p.issuedAt ?? new Date(),
    expirationTime: p.expiresAt,
    statement: `Sign in to Forkfall (testnet). This authorizes a temporary session key to sign your game moves until it expires. It cannot move funds or sign match results.`,
    resources: [`${SESSION_RESOURCE_PREFIX}${p.sessionKey}`],
  });
}

/** The session key signs this with a fresh server nonce to prove it holds the key. */
export function sessionProofMessage(nonce: string): string {
  return `Forkfall session proof\nnonce: ${nonce}`;
}

export function sessionKeyFromMessage(message: string): Address | null {
  const parsed = parseSiweMessage(message);
  const r = parsed.resources?.find((x) => x.startsWith(SESSION_RESOURCE_PREFIX));
  if (!r) return null;
  const key = r.slice(SESSION_RESOURCE_PREFIX.length);
  return isAddress(key) ? getAddress(key) : null;
}
