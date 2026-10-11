import { ForkfallClient, runMatch } from '@forkfall/sdk';
import type { AddressInfo } from 'node:net';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chain } from '../src/chain.ts';
import { createApi } from '../src/http.ts';
import { Lobby } from '../src/lobby.ts';

// runMatch must stay within the referee's per-client rate limit: a 429 anywhere in the loop is a back-off, not a crash.
describe('runMatch under the rate limit', () => {
  const lobby = new Lobby({ chain: new Chain(null), house: privateKeyToAccount(generatePrivateKey()) });
  const { server } = createApi(lobby, { ratePerSec: 20 }); // burst 60
  let url = '';
  beforeAll(async () => { await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
  afterAll(() => server.close());

  /** Step the house bot until the match ends or `loop` settles. */
  async function driveBot(id: Hex, loop: Promise<unknown>) {
    let settled = false;
    loop.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 4000 && !settled && lobby.get(id).phase !== 'ended'; i++) {
      await lobby.stepBots();
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  it('finishes a practice match it starts with an empty bucket, polling fast enough to hit 429s', async () => {
    const c = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
    await c.connect({ agent: true });
    const id = await c.practice({ race: 'prophets', botRace: 'brokers', bot: 'greedy' });
    // Spend the whole burst so runMatch's very first read (before its loop) is rate limited.
    let limited = false;
    for (let i = 0; i < 200 && !limited; i++) limited = await c.state(id).then(() => false, (e) => / → 429: /.test(String(e)));
    expect(limited).toBe(true);
    const backoffs: string[] = [];
    const loop = runMatch(c, id, { pollMs: 1, live: false, backoffMs: 100, log: (m) => { if (m.includes('rate limited')) backoffs.push(m); } });
    await driveBot(id, loop);
    const end = await loop;
    expect(end.phase).toBe('ended');
    expect(backoffs.length).toBeGreaterThan(0);
  }, 60_000);

  it('does not retry other errors, even when the path happens to contain "429"', async () => {
    const c = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
    await c.connect({ agent: true });
    const missing = `0x${'429'.repeat(21)}0` as Hex;
    await expect(runMatch(c, missing, { live: false, backoffMs: 60_000 })).rejects.toThrow(/→ 404:/);
  });
});
