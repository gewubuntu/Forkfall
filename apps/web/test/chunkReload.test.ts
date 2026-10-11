import { describe, expect, it } from 'vitest';
import { claimReload, isChunkLoadError } from '../src/lib/chunkReload.ts';

const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };

describe('reloading into a new build', () => {
  it('recognises a failed page chunk in each browser, and nothing else', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/Profile-abc.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });
  it('reloads at most once a minute, so a broken chunk shows an error instead of looping', () => {
    const s = store();
    expect(claimReload(s, 1_000_000)).toBe(true);
    expect(claimReload(s, 1_030_000)).toBe(false);
    expect(claimReload(s, 1_061_000)).toBe(true);
    expect(claimReload(null)).toBe(false);
  });
});
