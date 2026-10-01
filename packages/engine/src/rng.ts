import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';

export function keccakHex(...parts: (string | Uint8Array)[]): string {
  const bytes = parts.map((p) => (typeof p === 'string' ? (isHex(p) ? hexToBytes(strip(p)) : utf8ToBytes(p)) : p));
  return '0x' + bytesToHex(keccak_256(concatBytes(...bytes)));
}

function isHex(s: string): boolean { return /^0x([0-9a-fA-F]{2})*$/.test(s); }
function strip(s: string): string { return s.slice(2); }

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

/**
 * Counter-based deterministic RNG: word_i = keccak256(seed || uint32(i)).
 * Same inputs produce the same draws in the client, agent SDK, referee server and a future on-chain verifier.
 */
export function randWord(seed: string, counter: number): number {
  const h = keccak_256(concatBytes(hexToBytes(strip(seed)), u32be(counter)));
  return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
}

/** Fisher-Yates shuffle driven by randWord(seed, i). */
export function shuffle<T>(items: T[], seed: string): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randWord(seed, out.length - 1 - i) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Combine both players' revealed seed shares into the match seed. */
export function combineSeeds(matchId: string, a: string, b: string): string {
  return keccakHex(matchId, a, b);
}

export function randomHex32(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return '0x' + bytesToHex(b);
}
