import { describe, expect, it } from 'vitest';
import { retryRateLimited } from '../src/lib/retry.ts';

const limited = () => new Error('POST /v1/matches/0xab/moves → 429: rate limited');

describe('retryRateLimited (moves and concede in the web app)', () => {
  it('sends a rate-limited request again until it lands', async () => {
    let n = 0;
    await expect(retryRateLimited(async () => { if (++n < 3) throw limited(); return 'ok'; }, 4, 1)).resolves.toBe('ok');
    expect(n).toBe(3);
  });
  it('gives up after the last try', async () => {
    let n = 0;
    await expect(retryRateLimited(async () => { n++; throw limited(); }, 4, 1)).rejects.toThrow('429');
    expect(n).toBe(4);
  });
  it('passes any other error straight through, without retrying', async () => {
    let n = 0;
    await expect(retryRateLimited(async () => { n++; throw new Error('POST /v1/matches/0xab/moves → 400: stale seq'); }, 4, 1)).rejects.toThrow('stale seq');
    expect(n).toBe(1);
  });
  it('is not fooled by a 429 inside a match id', async () => {
    let n = 0;
    await expect(retryRateLimited(async () => { n++; throw new Error('GET /v1/matches/0x429a → 404: not found'); }, 4, 1)).rejects.toThrow('404');
    expect(n).toBe(1);
  });
});
