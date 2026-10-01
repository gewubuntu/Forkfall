import { MAX_SESSION_SECONDS, sessionKeyFromMessage, sessionProofMessage, type Delegation } from '@forkfall/sdk';
import { getAddress, recoverMessageAddress, verifyMessage, type Address, type Hex } from 'viem';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import type { Chain } from './chain.ts';
import { ApiError } from './lobby.ts';

export interface VerifiedSession {
  wallet: Address;
  sessionKey: Address;
  expiresAt: number;
  delegation: Delegation;
}

/**
 * Verify a wallet's SIWE delegation to a session key plus the session key's proof over a fresh nonce.
 * Smart-wallet (ERC-1271 / ERC-6492, e.g. Coinbase Smart Wallet) signatures need the server's RPC.
 */
export async function verifySessionLogin(p: {
  delegation: Delegation;
  nonce: string;
  proof: Hex;
  chain: Chain;
  /** Browser Origin header, when present the SIWE domain must match it (phishing protection). */
  origin?: string;
  now?: Date;
}): Promise<VerifiedSession> {
  const now = p.now ?? new Date();
  const { message, signature } = p.delegation ?? ({} as Delegation);
  if (typeof message !== 'string' || typeof signature !== 'string') throw new ApiError(400, 'delegation {message, signature} required');

  let fields;
  try { fields = parseSiweMessage(message); } catch { throw new ApiError(400, 'delegation is not a SIWE message'); }
  if (!fields.address || !fields.chainId || !fields.expirationTime || !fields.issuedAt) {
    throw new ApiError(400, 'delegation must include address, chainId, issuedAt and expirationTime');
  }
  if (fields.chainId !== p.chain.chainId) {
    throw new ApiError(400, `sign in on chain ${p.chain.chainId} (message was for chain ${fields.chainId})`);
  }
  if (p.origin) {
    let host = '';
    try { host = new URL(p.origin).host; } catch { /* ignore */ }
    if (host && host !== fields.domain) throw new ApiError(401, `sign-in message is for ${fields.domain}, not ${host}`);
  }
  const lifetime = (fields.expirationTime.getTime() - fields.issuedAt.getTime()) / 1000;
  if (lifetime > MAX_SESSION_SECONDS) throw new ApiError(400, 'session may last at most 24 hours');
  if (!validateSiweMessage({ message: fields, time: now })) throw new ApiError(401, 'sign-in message expired or not yet valid');

  const sessionKey = sessionKeyFromMessage(message);
  if (!sessionKey) throw new ApiError(400, 'delegation does not name a session key');

  const wallet = getAddress(fields.address);
  const valid = p.chain.client
    ? await p.chain.client.verifyMessage({ address: wallet, message, signature: signature as Hex }).catch(() => false)
    : await verifyMessage({ address: wallet, message, signature: signature as Hex }).catch(() => false);
  if (!valid) {
    throw new ApiError(401, p.chain.client
      ? 'wallet signature invalid'
      : 'wallet signature invalid (smart-wallet signatures need the server to run with RPC_URL)');
  }

  const prover = await recoverMessageAddress({ message: sessionProofMessage(p.nonce), signature: p.proof }).catch(() => null);
  if (!prover || prover !== sessionKey) throw new ApiError(401, 'session key proof invalid');

  return { wallet, sessionKey, expiresAt: fields.expirationTime.getTime(), delegation: { message, signature: signature as Hex } };
}
