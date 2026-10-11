import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForkfallClient, runMatch, type MatchSnapshot } from '../src/index.ts';

const ID = `0x${'ab'.repeat(32)}` as Hex;
const rateLimited = (method: string, path: string) => new Error(`${method} ${path} → 429: rate limited`);
const ended = { phase: 'ended', seq: 9, head: ID } as unknown as MatchSnapshot;
const myTurn = (seq: number) => ({
  phase: 'active', seat: 0, seq, head: ID, view: { active: 0, turn: 1 }, legalActions: [{ type: 'endTurn' }],
}) as unknown as MatchSnapshot;

const endTurn = () => ({ type: 'endTurn' as const });

/** A stand-in for ForkfallClient: each method answers from `impl`, and every call is recorded. */
function fakeClient(impl: Partial<Record<'state' | 'reveal' | 'move' | 'signResult', () => unknown>>) {
  const calls: { name: string; at: number }[] = [];
  const method = (name: keyof typeof impl) => async () => { calls.push({ name, at: Date.now() }); return impl[name]!(); };
  const client = { state: method('state'), reveal: method('reveal'), move: method('move'), signResult: method('signResult') };
  return { client: client as unknown as ForkfallClient, calls, count: (name: string) => calls.filter((c) => c.name === name).length };
}

/** Throw a 429 the first time, then answer `then`. */
function once429<T>(name: string, then: () => T) {
  let hit = false;
  return () => { if (!hit) { hit = true; throw rateLimited('GET', `/v1/${name}`); } return then(); };
}

describe('runMatch backs off on a 429 anywhere, not only while polling', () => {
  it('co-signs the result and reads the final state through a 429 on each', async () => {
    let reads = 0;
    const finalRead = once429('final', () => ended);
    const { client, count } = fakeClient({
      state: () => (reads++ === 0 ? ended : finalRead()),
      signResult: once429('result', () => ({ ok: true, complete: true })),
    });
    const logs: string[] = [];
    expect((await runMatch(client, ID, { live: false, backoffMs: 1, log: (m) => logs.push(m) })).phase).toBe('ended');
    expect(count('signResult')).toBe(2); // retried, not logged as "result sign failed" and dropped
    expect(logs.some((m) => m.includes('result sign failed'))).toBe(false);
  });

  it('retries a rate-limited move instead of dropping it', async () => {
    const { client, count } = fakeClient({
      state: () => myTurn(0),
      move: once429('move', () => ended),
      signResult: () => ({ ok: true, complete: true }),
    });
    await runMatch(client, ID, { live: false, backoffMs: 1, pollMs: 60_000, decide: endTurn });
    expect(count('move')).toBe(2); // with a 60 s poll, a dropped move would time the test out instead
  }, 3000);

  it('spaces back-to-back moves in one turn by moveGapMs', async () => {
    let seq = 0;
    const { client, calls } = fakeClient({
      state: () => myTurn(seq),
      move: () => (++seq < 4 ? myTurn(seq) : ended),
      signResult: () => ({ ok: true, complete: true }),
    });
    await runMatch(client, ID, { live: false, moveGapMs: 50, decide: endTurn });
    const moves = calls.filter((c) => c.name === 'move').map((c) => c.at);
    expect(moves).toHaveLength(4);
    for (let i = 1; i < moves.length; i++) expect(moves[i] - moves[i - 1]).toBeGreaterThanOrEqual(45);
  });
});

describe('ForkfallClient.reveal', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('passes on a 429 from the secrets lookup instead of reporting "no secrets"', async () => {
    // Secrets for a challenge match are only found through GET /v1/challenges; rate limited, that lookup must
    // surface as a 429 (which runMatch retries), not be swallowed into a "no secrets" error it can't recover from.
    vi.stubGlobal('fetch', async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/v1/challenges') return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 });
      return new Response(JSON.stringify({ status: 'idle' }), { status: 200 });
    });
    const c = new ForkfallClient('http://referee.test', privateKeyToAccount(generatePrivateKey()));
    await expect(c.reveal(ID)).rejects.toThrow(/ → 429: /);
  });
});

describe('signResult', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('re-sends a rate-limited result submit without asking the wallet to sign again', async () => {
    let posts = 0;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      if (init.method === 'GET') return new Response(JSON.stringify({ result: { matchId: ID } }), { status: 200 });
      return ++posts === 1 ? new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }) : new Response(JSON.stringify({ ok: true, complete: false }), { status: 200 });
    });
    let signatures = 0;
    const c = new ForkfallClient('http://x', privateKeyToAccount(generatePrivateKey()), { signResult: async () => { signatures++; return '0x01' as Hex; } });
    (c as unknown as { config: unknown }).config = { domain: { name: 'Forkfall', version: '1', chainId: 1, verifyingContract: ID.slice(0, 42) } };
    await expect(c.signResult(ID)).resolves.toEqual({ ok: true, complete: false });
    expect(posts).toBe(2);
    expect(signatures).toBe(1);
  });
});
