import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { ForkfallClient, runMatch, RESULT_TYPES, MOVE_TYPES, actionHash, ZERO32 } from '@forkfall/sdk';
import { Chain } from '../src/chain.ts';
import { createApi } from '../src/http.ts';
import { Lobby } from '../src/lobby.ts';

let clock = 1_000_000;
const lobby = new Lobby({
  chain: new Chain(null),
  house: privateKeyToAccount(generatePrivateKey()),
  now: () => clock,
});
const { server } = createApi(lobby, { ratePerSec: 10_000 });
let url = '';

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const newClient = () => new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));

describe('referee server', () => {
  it('two agents queue, play a full signed match and co-sign the result', async () => {
    const a = newClient();
    const b = newClient();
    await a.connect({ agent: true });
    await b.connect({ agent: true });
    expect((await a.queue({ mode: 'ranked', race: 'agents' })).status).toBe('queued');
    const qb = await b.queue({ mode: 'ranked', race: 'degens' });
    expect(qb.status).toBe('matched');
    const qa = await a.queueStatus();
    expect(qa.matchId).toBe(qb.matchId);

    const [ea, eb] = await Promise.all([runMatch(a, qb.matchId!, { pollMs: 5 }), runMatch(b, qb.matchId!, { pollMs: 5 })]);
    expect(ea.phase).toBe('ended');
    expect(eb.view!.winner).not.toBeNull();

    const settle = await a.settlement(qb.matchId!) as any;
    expect(settle.byReferee).toBe(false);
    const signerA = await recoverTypedDataAddress({
      domain: settle.domain, types: RESULT_TYPES, primaryType: 'MatchResult', message: settle.result, signature: settle.sigA,
    });
    expect(signerA).toBe(a.address);

    // Full log is public after the match and every move signature verifies against the hash chain.
    const log = await a.log(qb.matchId!) as any;
    expect(log.moves.length).toBeGreaterThan(5);
    let prev: Hex = ZERO32;
    for (const mv of log.moves.slice(0, 5)) {
      const signer = await recoverTypedDataAddress({
        domain: settle.domain, types: MOVE_TYPES, primaryType: 'Move',
        message: { matchId: qb.matchId!, seq: mv.seq, prevHash: prev, actionHash: actionHash(mv.action) },
        signature: mv.signature,
      });
      expect([a.address, b.address]).toContain(signer);
      prev = mv.head;
    }
  });

  it('practice vs house bot plays to completion', async () => {
    const c = newClient();
    await c.connect();
    const matchId = await c.practice({ race: 'brokers', botRace: 'prophets' });
    const loop = runMatch(c, matchId, { pollMs: 5 });
    for (let i = 0; i < 2000 && lobby.get(matchId).phase !== 'ended'; i++) {
      await lobby.stepBots();
      await new Promise((r) => setTimeout(r, 2));
    }
    const end = await loop;
    expect(end.phase).toBe('ended');
    await lobby.stepBots(); // house co-signs
    const s = await c.settlement(matchId) as any;
    expect(s.sigA && s.sigB).toBeTruthy();
  });

  it('rejects forged move signatures, stale seq and out-of-turn moves', async () => {
    const a = newClient(); const b = newClient();
    await a.connect(); await b.connect();
    await a.queue({ mode: 'casual', race: 'agents' });
    const { matchId } = await b.queue({ mode: 'casual', race: 'brokers' });
    await a.reveal(matchId!); await b.reveal(matchId!);
    const snapA = await a.state(matchId!);
    const mover = snapA.view!.active === snapA.seat ? a : b;
    const other = mover === a ? b : a;
    const snap = await mover.state(matchId!);
    await expect(other.move(matchId!, snap, { type: 'endTurn' })).rejects.toThrow(/not your turn/);
    await expect(mover.move(matchId!, { ...snap, seq: 7 }, { type: 'endTurn' })).rejects.toThrow(/stale seq/);
    // signature by a different key
    const forged = await other.account.signTypedData({
      domain: mover.config!.domain, types: MOVE_TYPES, primaryType: 'Move',
      message: { matchId: matchId!, seq: snap.seq, prevHash: snap.head, actionHash: actionHash({ type: 'endTurn' }) },
    });
    const res = await fetch(`${url}/v1/matches/${matchId}/moves`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${mover.token}` },
      body: JSON.stringify({ seq: snap.seq, action: { type: 'endTurn' }, signature: forged }),
    });
    expect(res.status).toBe(401);
    // opponent's hand is hidden
    expect(snap.view!.hand.length).toBeGreaterThan(0);
    const oppSeat = snap.seat === 0 ? 1 : 0;
    expect(snap.view!.players[oppSeat]).not.toHaveProperty('hand');
  });

  it('timer auto-ends turns and forfeits after repeated timeouts', async () => {
    const a = newClient(); const b = newClient();
    await a.connect(); await b.connect();
    await a.queue({ mode: 'casual', race: 'agents' });
    const { matchId } = await b.queue({ mode: 'casual', race: 'degens' });
    await a.reveal(matchId!); await b.reveal(matchId!);
    const m = lobby.get(matchId!);
    const idle = m.state!.active;
    // Idle player's turns time out; the active opponent just ends turns.
    for (let i = 0; i < 10 && m.phase === 'active'; i++) {
      if (m.state!.active === idle) { clock += 200_000; lobby.tick(); }
      else {
        const c = m.players[m.state!.active].address === a.address ? a : b;
        await c.move(matchId!, await c.state(matchId!), { type: 'endTurn' });
      }
    }
    expect(m.phase).toBe('ended');
    expect(m.state!.endReason).toBe('timeout');
    expect(m.state!.winner).toBe(idle === 0 ? 1 : 0);
  });

  it('drops queue entries whose client stopped polling, and reports cancelled matches', async () => {
    const ghost = newClient(); const live = newClient(); const late = newClient();
    await ghost.connect(); await live.connect(); await late.connect();
    await ghost.queue({ mode: 'human', race: 'agents' });
    clock += 31_000; // ghost never polls again
    const r = await live.queue({ mode: 'human', race: 'brokers' });
    expect(r.status).toBe('queued');
    expect((await ghost.queueStatus()).status).toBe('idle');
    // A real pairing whose second player never reveals is cancelled after 60 s.
    const { matchId } = await late.queue({ mode: 'human', race: 'degens' });
    expect(matchId).toBeTruthy();
    await live.reveal(matchId!);
    clock += 61_000;
    lobby.tick();
    expect((await live.state(matchId!)).phase).toBe('cancelled');
  });

  it('requires auth and a seed commitment', async () => {
    const r = await fetch(`${url}/v1/queue`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
    const c = newClient(); await c.connect();
    const r2 = await fetch(`${url}/v1/queue`, {
      method: 'POST', headers: { authorization: `Bearer ${c.token}` }, body: JSON.stringify({ mode: 'casual', race: 'agents' }),
    });
    expect(r2.status).toBe(400);
  });
});
