import { ForkfallClient, LiveClient, runMatch } from '@forkfall/sdk';
import { connect, type AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { Live } from '../src/live.ts';
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

  it('survives malformed messages (one bad frame must never take the referee down)', async () => {
    const s = await socket();
    for (const raw of ['null', '1', '"x"', '[]', '{"type":null}', '{"type":"sub","topic":{}}', '{"type":"auth","token":5}', 'not json']) s.ws.send(raw);
    s.send({ type: 'ping' });
    await s.waitFor((m) => m.type === 'pong');
    expect(s.msgs.filter((m) => m.type === 'error').length).toBeGreaterThanOrEqual(7);
    const res = await fetch(`${url}/v1/config`);
    expect(res.ok).toBe(true);
    s.ws.close();
  });

  it('logout stops personal notices right away', async () => {
    const a = await player(); const b = await player();
    const s = await socket();
    s.send({ type: 'auth', token: tokenOf(a) });
    await s.waitFor((m) => m.type === 'authed');
    s.send({ type: 'sub', topic: 'me' });
    await s.waitFor((m) => m.type === 'subbed');
    // The socket's holder is not the client that logs out (e.g. a leaked token): the server must still cut it off.
    const holder = new ForkfallClient(url, a.account);
    (holder as unknown as { token: string }).token = tokenOf(a);
    await holder.logout();
    await s.waitFor((m) => m.type === 'unauthed');
    await b.createChallenge({ race: 'agents', to: a.address });
    await new Promise((r) => setTimeout(r, 100));
    expect(s.msgs.filter((m) => m.type === 'event')).toEqual([]);
    // Re-auth with the dead token fails and leaves the socket signed out.
    s.send({ type: 'auth', token: tokenOf(a) });
    await s.waitFor((m) => m.type === 'error' && m.auth === true);
    s.send({ type: 'sub', topic: 'me' });
    await s.waitFor((m) => m.type === 'error' && m.message === 'authenticate first');
    s.ws.close();
  });

  it('closes a socket that floods messages', async () => {
    const s = await socket();
    const closed = new Promise<number>((r) => s.ws.addEventListener('close', (e) => r(e.code)));
    for (let i = 0; i < 200; i++) s.send({ type: 'ping' });
    expect(await closed).toBe(1008);
  });

  it('LiveClient reports `me` as up only while the session is accepted', async () => {
    const a = await player();
    let token: string | undefined = 'bogus';
    const live = new LiveClient(wsUrl, { token: () => token });
    const seen: string[] = [];
    live.on('me', (e) => seen.push(e.kind));
    live.on('lobby', () => {});
    const until = async (f: () => boolean) => { const end = Date.now() + 3000; while (!f()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };
    await until(() => live.connected && live.lastError !== null);
    expect(live.isUp('lobby')).toBe(true);
    expect(live.isUp('me')).toBe(false); // bad token: callers keep polling fast
    token = tokenOf(a);
    live.reauth();
    await until(() => live.isUp('me'));
    const b = await player();
    await b.createChallenge({ race: 'agents', to: a.address });
    await until(() => seen.includes('challenge'));
    live.close();
    expect(live.connected).toBe(false);
    expect(live.isUp('lobby')).toBe(false);
  });

  it('runMatch closes the socket it opened, so scripts can exit', async () => {
    const settle = async (f: () => boolean) => { const end = Date.now() + 3000; while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); };
    await settle(() => api.live.size === 0); // sockets from earlier tests finish closing
    expect(api.live.size).toBe(0);
    // Two players (no bot loop runs in this test server); whoever moves first concedes.
    const a = await player(); const b = await player();
    const id = await b.acceptChallenge((await a.createChallenge({ race: 'agents' })).code, { race: 'degens' });
    let during = -1;
    const decide = () => { during = api.live.size; return { type: 'concede' as const }; };
    await Promise.all([runMatch(a, id, { pollMs: 2, decide }), runMatch(b, id, { pollMs: 2, decide })]);
    expect(during).toBe(2);
    await settle(() => api.live.size === 0);
    expect(api.live.size).toBe(0);
  }, 15_000);

  it('a socket refused at the cap that sends a bad frame does not crash the server', async () => {
    const srv = createServer();
    const live = new Live(srv, { authenticate: () => null, maxSocketsPerIp: 1 });
    await new Promise<void>((r) => srv.listen(0, r));
    const port = (srv.address() as AddressInfo).port;
    const first = new WebSocket(`ws://127.0.0.1:${port}/v1/live`);
    await new Promise((r) => first.addEventListener('open', r));
    // Second socket from the same IP: refused. Send a frame with RSV2/RSV3 set before the close lands.
    const raw = connect(port, '127.0.0.1');
    await new Promise((r) => raw.on('connect', r));
    raw.write('GET /v1/live HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    await new Promise((r) => raw.once('data', r)); // 101 Switching Protocols
    raw.write(Buffer.from([0xb1, 0x80, 0, 0, 0, 0])); // FIN + RSV2 + RSV3, text, masked, empty
    await new Promise((r) => setTimeout(r, 200));
    // Still alive: a new socket on the original connection's server answers.
    const ok = await fetch(`${url}/v1/config`);
    expect(ok.ok).toBe(true);
    expect(first.readyState).toBe(WebSocket.OPEN);
    raw.destroy(); first.close(); live.close(); srv.close();
  });

  it('a closeLive() between borrows never leaves the next socket open', async () => {
    const a = await player();
    const x = a.retainLive();
    a.closeLive(); // e.g. logout while a match runs
    const y = a.retainLive();
    expect(y.live).not.toBe(x.live);
    x.release(); // the old borrow must not count against the new socket
    expect((a as unknown as { liveClient?: unknown }).liveClient).toBe(y.live);
    y.release();
    expect((a as unknown as { liveClient?: unknown }).liveClient).toBeUndefined();
  });
});
