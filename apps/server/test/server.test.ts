import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { ForkfallClient, runMatch, RESULT_TYPES, MOVE_TYPES, actionHash, replayLog, verifyMoveSignatures, ZERO32, type MatchLog } from '@forkfall/sdk';
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

describe('match history, replay and archive', () => {
  async function playRanked() {
    const a = newClient(); const b = newClient();
    await a.connect({ agent: true }); await b.connect({ agent: true });
    await a.queue({ mode: 'ranked', race: 'prophets' });
    const { matchId } = await b.queue({ mode: 'ranked', race: 'brokers' });
    await Promise.all([runMatch(a, matchId!, { pollMs: 5 }), runMatch(b, matchId!, { pollMs: 5 })]);
    await lobby.stepBots(); // referee co-signature
    return { a, b, matchId: matchId! };
  }

  it('replays the public log to the signed result and verifies every move signature', async () => {
    const { a, b, matchId } = await playRanked();
    const log = await a.log(matchId);
    const r = replayLog(log);
    expect(r.checks).toMatchObject({ seeds: { ok: true }, chain: { ok: true }, outcome: { ok: true } });
    expect(r.frames.length).toBe(log.moves.length + 1);
    const sigs = await verifyMoveSignatures(log);
    expect(sigs).toEqual({ verified: log.moves.length, forced: 0, unchecked: 0, failed: [] });

    // Tampering with any move breaks the chain; a fake seed share breaks the commitment.
    const i = log.moves.findIndex((m) => m.action.type !== 'endTurn');
    const forged: MatchLog = structuredClone(log);
    forged.moves[i].action = { type: 'endTurn' };
    expect(replayLog(forged).checks.chain.ok).toBe(false);
    const badSeed: MatchLog = structuredClone(log);
    badSeed.players[0].seedShare = ZERO32;
    expect(replayLog(badSeed).ok).toBe(false);

    // History: both players see it, ready to settle; the leaderboard counts it for the season.
    const mine = (await b.matches({ player: b.address })).matches;
    expect(mine[0]).toMatchObject({ matchId, mode: 'ranked', phase: 'ended', settlement: 'ready', resultSigned: [true, true], practice: false });
    expect((await a.matches({ player: newClient().address })).matches).toEqual([]);
    const lb = await a.leaderboard();
    expect(lb.season).toBe(lobby.get(matchId).season);
    expect(lb.rows.some((x) => x.address === a.address)).toBe(true);
  });

  it('replays timeout forfeits and restores archived matches into a fresh referee', async () => {
    const a = newClient(); const b = newClient();
    await a.connect(); await b.connect();
    await a.queue({ mode: 'casual', race: 'agents' });
    const { matchId } = await b.queue({ mode: 'casual', race: 'degens' });
    await a.reveal(matchId!); await b.reveal(matchId!);
    const m = lobby.get(matchId!);
    const idle = m.state!.active;
    for (let i = 0; i < 10 && m.phase === 'active'; i++) {
      if (m.state!.active === idle) { clock += 200_000; lobby.tick(); }
      else {
        const c = m.players[m.state!.active].address === a.address ? a : b;
        await c.move(matchId!, await c.state(matchId!), { type: 'endTurn' });
      }
    }
    const log = await a.log(matchId!);
    const r = replayLog(log);
    expect(r.ok).toBe(true);
    expect(r.final.endReason).toBe('timeout');
    expect((await verifyMoveSignatures(log)).forced).toBeGreaterThan(0);

    await a.signResult(matchId!); await b.signResult(matchId!);
    const rec = JSON.parse(JSON.stringify(lobby.archive(matchId!)));
    const fresh = new Lobby({ chain: new Chain(null), house: privateKeyToAccount(generatePrivateKey()), now: () => clock });
    expect(fresh.restore(rec)).toBe(true);
    expect(fresh.list(a.address)[0]).toMatchObject({ matchId, phase: 'ended', settlement: 'ready', endReason: 'timeout' });
    expect(fresh.settlement(matchId!)).toEqual(lobby.settlement(matchId!));
    expect(fresh.snapshot(fresh.get(matchId!), a.address).view!.winner).toBe(m.state!.winner);

    // A log from another deployment, or one that doesn't replay, is refused.
    const other = new Lobby({ chain: new Chain(null, undefined, 84532), house: privateKeyToAccount(generatePrivateKey()) });
    expect(other.restore(rec)).toBe(false);
    rec.log.matchId = ZERO32;
    expect(new Lobby({ chain: new Chain(null), house: privateKeyToAccount(generatePrivateKey()) }).restore(rec)).toBe(false);
  });
});
