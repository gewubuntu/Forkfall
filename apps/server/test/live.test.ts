import { ForkfallClient, runMatch } from '@forkfall/sdk';
import type { AddressInfo } from 'node:net';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chain } from '../src/chain.ts';
import { createApi } from '../src/http.ts';
import { Lobby } from '../src/lobby.ts';

const lobby = new Lobby({ chain: new Chain(null), house: privateKeyToAccount(generatePrivateKey()) });
const api = createApi(lobby, { ratePerSec: 10_000 });
let url = '';
let wsUrl = '';
beforeAll(async () => {
  await new Promise<void>((r) => api.server.listen(0, r));
  const port = (api.server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/v1/live`;
});
afterAll(() => { api.live.close(); api.server.close(); });

/** A raw socket that records every message. */
async function socket() {
  const ws = new WebSocket(wsUrl);
  const msgs: Record<string, unknown>[] = [];
  ws.addEventListener('message', (e) => msgs.push(JSON.parse(String(e.data))));
  await new Promise<void>((r, j) => { ws.addEventListener('open', () => r()); ws.addEventListener('error', () => j(new Error('ws failed'))); });
  const send = (m: object) => ws.send(JSON.stringify(m));
  const waitFor = async (pred: (m: Record<string, unknown>) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = msgs.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(msgs)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { ws, msgs, send, waitFor };
}

const player = async () => { const c = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey())); await c.connect(); return c; };
const tokenOf = (c: ForkfallClient) => (c as unknown as { token: string }).token;

describe('live notices', () => {
  it('pushes a match update to subscribers on every move, to spectators too', async () => {
    const a = await player(); const b = await player();
    const ch = await a.createChallenge({ race: 'agents' });
    const matchId = await b.acceptChallenge(ch.code, { race: 'degens' });
    const spectator = await socket();
    spectator.send({ type: 'sub', topic: `match:${matchId}` });
    await spectator.waitFor((m) => m.type === 'subbed');
    await Promise.all([runMatch(a, matchId, { pollMs: 2 }), runMatch(b, matchId, { pollMs: 2 })]);
    const updates = spectator.msgs.filter((m) => m.type === 'event' && m.topic === `match:${matchId}`);
    expect(updates.length).toBeGreaterThan(5);
    expect(updates.at(-1)).toMatchObject({ kind: 'update', phase: 'ended' });
    // Signals only: no game state travels over the socket.
    expect(JSON.stringify(spectator.msgs)).not.toMatch(/hand|deck|cardId|seedShare/);
    spectator.ws.close();
  });

  it('personal notices need a session and only reach their owner', async () => {
    const a = await player(); const b = await player(); const other = await player();
    const anon = await socket();
    anon.send({ type: 'sub', topic: 'me' });
    await anon.waitFor((m) => m.type === 'error' && m.message === 'authenticate first');
    anon.send({ type: 'auth', token: 'nope' });
    await anon.waitFor((m) => m.type === 'error' && /unknown or expired/.test(String(m.message)));
    anon.send({ type: 'sub', topic: 'me:0xabc' });
    await anon.waitFor((m) => m.type === 'error' && m.message === 'unknown topic');

    const sa = await socket(); const so = await socket();
    sa.send({ type: 'auth', token: tokenOf(a) }); so.send({ type: 'auth', token: tokenOf(other) });
    await sa.waitFor((m) => m.type === 'authed'); await so.waitFor((m) => m.type === 'authed');
    sa.send({ type: 'sub', topic: 'me' }); so.send({ type: 'sub', topic: 'me' });
    await sa.waitFor((m) => m.type === 'subbed'); await so.waitFor((m) => m.type === 'subbed');

    // B challenges A directly: A hears about it, the other player doesn't.
    const c = await b.createChallenge({ race: 'agents', to: a.address });
    await sa.waitFor((m) => m.type === 'event' && m.kind === 'challenge' && m.code === c.code);
    // A accepts: both players get the new match (B wasn't subscribed here; A was).
    const matchId = await a.acceptChallenge(c.code, { race: 'brokers' });
    await sa.waitFor((m) => m.type === 'event' && m.kind === 'match' && m.matchId === matchId);
    await new Promise((r) => setTimeout(r, 50));
    expect(so.msgs.filter((m) => m.type === 'event')).toEqual([]);
    for (const s of [anon, sa, so]) s.ws.close();
  });

  it('a practice match notifies its player, and the lobby topic hears about new matches', async () => {
    const a = await player();
    const s = await socket();
    s.send({ type: 'auth', token: tokenOf(a) });
    await s.waitFor((m) => m.type === 'authed');
    s.send({ type: 'sub', topic: 'me' }); s.send({ type: 'sub', topic: 'lobby' });
    await s.waitFor((m) => m.type === 'subbed' && m.topic === 'lobby');
    const id = await a.practice({ race: 'agents' });
    await s.waitFor((m) => m.type === 'event' && m.kind === 'match' && m.matchId === id);
    await s.waitFor((m) => m.type === 'event' && m.topic === 'lobby', 3000);
    s.ws.close();
  });

  it('limits live connections per wallet', async () => {
    const a = await player();
    const socks = [];
    for (let i = 0; i < 8; i++) {
      const s = await socket(); s.send({ type: 'auth', token: tokenOf(a) });
      await s.waitFor((m) => m.type === 'authed'); socks.push(s);
    }
    const ninth = await socket();
    ninth.send({ type: 'auth', token: tokenOf(a) });
    await ninth.waitFor((m) => m.type === 'error' && /too many live connections/.test(String(m.message)));
    for (const s of [...socks, ninth]) s.ws.close();
  });
});
