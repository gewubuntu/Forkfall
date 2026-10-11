import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { ForkfallClient, withRateLimitRetry, type MatchSnapshot } from '../src/index.ts';

const ID = `0x${'ab'.repeat(32)}` as Hex;
const rateLimited = (method: string, path: string) => new Error(`${method} ${path} → 429: rate limited`);
const ended = { phase: 'ended', seq: 9, head: ID } as unknown as MatchSnapshot;
const myTurn = (seq: number) => ({ phase: 'active', seat: 0, seq, head: ID, view: { active: 0, turn: 1 }, legalActions: [{ type: 'endTurn' }] }) as unknown as MatchSnapshot;
/** Throw a 429 the first time, then answer `then`. */
function once429<T>(name: string, then: () => T) {
  let hit = false;
  return () => { if (!hit) { hit = true; throw rateLimited('GET', `/v1/${name}`); } return then(); };
}

describe('withRateLimitRetry', () => {
  it('sends again on a 429, passes other errors through, gives up after the last try', async () => {
    let n = 0;
    await expect(withRateLimitRetry(async () => { if (++n < 3) throw rateLimited('POST', '/v1/x'); return 'ok'; }, { backoffMs: 1 })).resolves.toBe('ok');
    expect(n).toBe(3);
    n = 0;
    await expect(withRateLimitRetry(async () => { n++; throw new Error('POST /v1/x → 400: bad'); }, { backoffMs: 1 })).rejects.toThrow('400');
    expect(n).toBe(1);
    n = 0;
    await expect(withRateLimitRetry(async () => { n++; throw rateLimited('GET', '/v1/x'); }, { tries: 3, backoffMs: 1 })).rejects.toThrow('429');
    expect(n).toBe(3);
  });
});

describe('concede', () => {
  /** A real client whose state() and move() answer from the given functions. */
  function stubbed(move: () => unknown, state: () => unknown = () => myTurn(1)) {
    const c = new ForkfallClient('http://x', privateKeyToAccount(generatePrivateKey()));
    const calls = { move: 0, state: 0 };
    Object.assign(c, { move: async () => { calls.move++; return move(); }, state: async () => { calls.state++; return state(); } });
    return { c, calls };
  }

  it('lands through a 429 instead of failing (custom agents call it directly)', async () => {
    const { c, calls } = stubbed(once429('moves', () => ended));
    await expect(c.concede(ID, { snap: myTurn(0), rateLimitMs: 1 })).resolves.toBe(ended);
    expect(calls.move).toBe(2);
  });

  it('reads the fresh position through a 429 too', async () => {
    let first = true;
    const { c } = stubbed(() => { if (first) { first = false; throw new Error('POST /v1/matches/x/moves → 409: stale seq'); } return ended; }, once429('state', () => myTurn(2)));
    await expect(c.concede(ID, { snap: myTurn(0), retryMs: 1, rateLimitMs: 1 })).resolves.toBe(ended);
  });

  it('still fails fast on any other error', async () => {
    const { c, calls } = stubbed(() => { throw new Error('POST /v1/matches/x/moves → 400: match over'); });
    await expect(c.concede(ID, { snap: myTurn(0), rateLimitMs: 1 })).rejects.toThrow('match over');
    expect(calls.move).toBe(1);
  });
});
