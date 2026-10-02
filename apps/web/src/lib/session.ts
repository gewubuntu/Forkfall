import type { Delegation, SecretStore } from '@forkfall/sdk';
import type { Address, Hex } from 'viem';

/**
 * The session key lives in this browser only. It can sign game moves until the delegation expires;
 * it cannot move funds or sign match results (the wallet does that).
 */
export interface StoredSession {
  pk: Hex;
  delegation: Delegation;
  expiresAt: number;
  chainId: number;
}

const key = (chainId: number, wallet: Address) => `forkfall.session.v1.${chainId}.${wallet.toLowerCase()}`;

export function loadSession(chainId: number, wallet: Address): StoredSession | null {
  try {
    const raw = localStorage.getItem(key(chainId, wallet));
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredSession;
    if (!s.pk || !s.delegation || s.expiresAt <= Date.now() + 30_000) { clearSession(chainId, wallet); return null; }
    return s;
  } catch { return null; }
}

export function saveSession(wallet: Address, s: StoredSession) {
  try { localStorage.setItem(key(s.chainId, wallet), JSON.stringify(s)); } catch { /* storage blocked: session lasts this tab only */ }
}

export function clearSession(chainId: number, wallet: Address) {
  try { localStorage.removeItem(key(chainId, wallet)); } catch { /* ignore */ }
}

export const SESSION_LENGTHS = [
  { hours: 1, label: '1 hour' },
  { hours: 8, label: '8 hours' },
  { hours: 24, label: '24 hours' },
] as const;

/**
 * Match secrets (seed share + private deck salt) until they are revealed. sessionStorage keeps them
 * across a reload of this tab without sharing them with other tabs. Challenge secrets (`challenge:<code>`) go
 * to localStorage instead: a challenge can be accepted hours later, when the challenger is in another tab.
 */
const durable = (k: string) => k.startsWith('challenge:');
export const sessionSecretStore: SecretStore = {
  get(k) {
    try {
      const v = sessionStorage.getItem(`forkfall.secret.${k}`) ?? (durable(k) ? localStorage.getItem(`forkfall.secret.${k}`) : null);
      return v ? JSON.parse(v) : undefined;
    } catch { return undefined; }
  },
  set(k, v) {
    try { (durable(k) ? localStorage : sessionStorage).setItem(`forkfall.secret.${k}`, JSON.stringify(v)); } catch { /* storage blocked: memory only */ }
  },
};
