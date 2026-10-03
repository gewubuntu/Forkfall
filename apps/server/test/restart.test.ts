import { commitSeed, ForkfallClient, replayLog, runMatch } from '@forkfall/sdk';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { afterAll, describe, expect, it } from 'vitest';
import { Chain } from '../src/chain.ts';
import { createApi } from '../src/http.ts';
import { Lobby, type LobbyOptions, type SavedLobby, type SavedMatch } from '../src/lobby.ts';
import { StateStore } from '../src/state.ts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A referee with a state directory, on a fixed port so clients keep their base URL across a "restart". */
function referee(dir: string, opts: Partial<LobbyOptions> & { onChange?: Lobby['onChange'] } = {}) {
  const store = new StateStore(dir);
  const { onChange, ...lobbyOpts } = opts;
  const lobby = new Lobby({ chain: new Chain(null), house: privateKeyToAccount(generatePrivateKey()), store, ...lobbyOpts });
  lobby.onChange = onChange;
  const saved = store.read<SavedLobby>('lobby.json');
  if (saved) lobby.restoreLobby(saved);
  let resumed = 0;
  for (const f of store.list('matches')) if (lobby.restoreRunning(store.read<SavedMatch>(f)!, saved?.aliveAt ?? 0) === 'resumed') resumed++;
  const api = createApi(lobby, { ratePerSec: 10_000, store });
  return {
    lobby, api, store, resumed,
    listen: (port = 0) => new Promise<number>((r) => api.server.listen(port, '127.0.0.1', () => r((api.server.address() as AddressInfo).port))),
    /** Simulate the process going away: save the lobby (as SIGTERM does), close everything. */
    stop: async () => {
      store.write('lobby.json', lobby.saveLobby());
      api.live.close();
      api.server.closeAllConnections();
      await new Promise((r) => api.server.close(r));
      await new Promise((r) => setTimeout(r, 50)); // clients notice their keep-alive sockets closed, as across a real restart
    },
  };
}
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'ff-state-')); dirs.push(d); return d; };

describe('referee restarts', () => {
  it('a match in progress continues after a restart, without signing in again', async () => {
    const dir = tmp();
    const r1 = referee(dir);
    const port = await r1.listen();
    const url = `http://127.0.0.1:${port}`;
    const a = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
    const b = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
    await a.connect(); await b.connect();
    const id = await b.acceptChallenge((await a.createChallenge({ race: 'agents' })).code, { race: 'degens' });
    await a.reveal(id); await b.reveal(id);
    // Play a few turns by hand.
    for (let i = 0; i < 4; i++) {
      const who = (await a.state(id)).view!.active === (await a.state(id)).seat ? a : b;
      await who.move(id, await who.state(id), { type: 'endTurn' });
    }
    const before = await a.state(id);
    expect(before.seq).toBe(4);
    await r1.stop();

    const r2 = referee(dir);
    expect(r2.resumed).toBe(1);
    await r2.listen(port);
    // Same tokens still work (sessions survived), and the match is exactly where it was.
    const after = await a.state(id);
    expect(after.seq).toBe(4);
    expect(after.head).toBe(before.head);
    expect(after.view).toEqual(before.view);
    // Finish it; the whole log (before and after the restart) replays and verifies.
    await Promise.all([runMatch(a, id, { pollMs: 2, live: false }), runMatch(b, id, { pollMs: 2, live: false })]);
    const log = await a.log(id);
    expect(log.moves.length).toBeGreaterThan(4);
    expect(replayLog(log).ok).toBe(true);
    await r2.stop();
    // Finished: nothing left in the running-match directory.
    expect(readdirSync(join(dir, 'matches')).filter((f) => f.endsWith('.json'))).toEqual([]);
  }, 30_000);

  it('downtime does not count against the player on turn or the reveal window', async () => {
    const dir = tmp();
    let t = 1_000_000;
    const now = () => t;
    const r1 = referee(dir, { now, revealSeconds: 60 });
    await r1.listen();
    const url = `http://127.0.0.1:${(r1.api.server.address() as AddressInfo).port}`;
    const a = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
    const b = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
    const c = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
    await a.connect(); await b.connect(); await c.connect();
    const active = await b.acceptChallenge((await a.createChallenge({ race: 'agents' })).code, { race: 'degens' });
    await a.reveal(active); await b.reveal(active);
    const waiting = await c.acceptChallenge((await a.createChallenge({ race: 'brokers' })).code, { race: 'prophets' });
    t += 30_000; // 30 s into the turn, the reveal window half gone
    r1.store.write('lobby.json', r1.lobby.saveLobby());
    await r1.stop();

    t += 10 * 60_000; // down for ten minutes
    const r2 = referee(dir, { now, revealSeconds: 60 });
    expect(r2.resumed).toBe(2);
    r2.lobby.tick();
    expect(r2.lobby.matches.get(active)!.phase).toBe('active');
    expect(r2.lobby.matches.get(active)!.moves.length).toBe(0); // no forced timeout
    expect(r2.lobby.matches.get(waiting)!.phase).toBe('reveal'); // not cancelled
    // The clocks run again from where they stopped: the rest of the turn + bank (105 s), the rest of the
    // challenge's 3-minute reveal window.
    t += 3 * 60_000;
    r2.lobby.tick();
    expect(r2.lobby.matches.get(waiting)!.phase).toBe('cancelled');
    expect(r2.lobby.matches.get(active)!.moves.length).toBe(1); // the turn timed out now
    await r2.stop();
  }, 30_000);

  it('the queue, challenges and sessions survive; session tokens are never written to disk', async () => {
    const dir = tmp();
    const r1 = referee(dir);
    const port = await r1.listen();
    const url = `http://127.0.0.1:${port}`;
    const a = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
    const b = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
    const c = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
    await a.connect(); await b.connect(); await c.connect();
    expect((await a.queue({ mode: 'casual', race: 'agents' })).status).toBe('queued');
    const ch = await c.createChallenge({ race: 'brokers', to: b.address });
    await r1.stop();
    const token = (a as unknown as { token: string }).token;
    expect(readFileSync(join(dir, 'sessions.json'), 'utf8')).not.toContain(token);

    const r2 = referee(dir);
    await r2.listen(port);
    expect((await a.queueStatus()).status).toBe('queued');
    expect((await b.challenges()).incoming.map((x) => x.code)).toContain(ch.code);
    // B queues: paired with A, who was waiting before the restart; A finds the match through its old ticket.
    const m = await b.queue({ mode: 'casual', race: 'degens' });
    expect(m.status).toBe('matched');
    expect((await a.queueStatus()).matchId).toBe(m.matchId);
    // Logout still works after a restart, and stays logged out across the next one.
    const cToken = (c as unknown as { token: string }).token;
    await c.logout();
    await r2.stop();
    const r3 = referee(dir);
    await r3.listen(port);
    const old = new ForkfallClient(url, c.account);
    (old as unknown as { token: string }).token = cToken;
    await expect(old.me()).rejects.toThrow(/401/);
    expect(await a.me()).toMatchObject({ address: a.address });
    await r3.stop();
  }, 30_000);

  it('refuses a running-match record whose moves were tampered with', async () => {
    const dir = tmp();
    const r1 = referee(dir);
    const port = await r1.listen();
    const url = `http://127.0.0.1:${port}`;
    const a = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
    const b = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
    await a.connect(); await b.connect();
    const id = await b.acceptChallenge((await a.createChallenge({ race: 'agents' })).code, { race: 'degens' });
    await a.reveal(id); await b.reveal(id);
    const s = await a.state(id);
    await (s.view!.active === s.seat ? a : b).move(id, s, { type: 'endTurn' });
    await r1.stop();
    const rec = r1.store.read<SavedMatch>(`matches/${id}.json`)!;
    rec.match.moves[0].head = ('0x' + '11'.repeat(32)) as Hex;
    r1.store.write(`matches/${id}.json`, rec);
    const r2 = referee(dir);
    expect(r2.resumed).toBe(0);
    expect(r2.lobby.matches.has(id)).toBe(false);
  });

  it('a second restart keeps the downtime credit of the first (no timeout after a crash loop)', async () => {
    const dir = tmp();
    let t = 1_000_000;
    const now = () => t;
    const r1 = referee(dir, { now });
    await r1.listen();
    const url = `http://127.0.0.1:${(r1.api.server.address() as AddressInfo).port}`;
    const a = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
    const b = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
    await a.connect(); await b.connect();
    const id = await b.acceptChallenge((await a.createChallenge({ race: 'agents' })).code, { race: 'degens' });
    await a.reveal(id); await b.reveal(id);
    t += 10_000;
    await r1.stop();
    t += 10 * 60_000; // down 10 minutes
    const r2 = referee(dir, { now });
    expect(r2.resumed).toBe(1);
    t += 20_000; // up for 20 s with no moves (heartbeat written), then down again
    r2.store.write('lobby.json', r2.lobby.saveLobby());
    t += 5_000;
    const r3 = referee(dir, { now });
    expect(r3.resumed).toBe(1);
    r3.lobby.tick();
    const m = r3.lobby.matches.get(id)!;
    expect(m.moves.length).toBe(0); // 10 s + 20 s of a 105 s turn+bank used: no forced timeout
    expect(m.clock.timeouts).toEqual([0, 0]);
    await r2.api.server.close(); await r3.api.server.close();
  }, 30_000);

  it('replays forced timeouts, and archives a finished match whose archive write failed at the next start', async () => {
    const dir = tmp();
    let t = 1_000_000;
    const now = () => t;
    let archiveWorks = false;
    const archived: string[] = [];
    const onChange = (m: { id: string; phase: string }) => {
      if (m.phase !== 'ended') return true;
      if (!archiveWorks) return false; // e.g. disk full
      archived.push(m.id);
      return true;
    };
    const r1 = referee(dir, { now, onChange, maxTimeouts: 2 });
    await r1.listen();
    const url = `http://127.0.0.1:${(r1.api.server.address() as AddressInfo).port}`;
    const a = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
    const b = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
    await a.connect(); await b.connect();
    const id = await b.acceptChallenge((await a.createChallenge({ race: 'agents' })).code, { race: 'degens' });
    await a.reveal(id); await b.reveal(id);
    // One forced timeout (an unsigned endTurn in the log), then a restart: the replay must match.
    t += 200_000; r1.lobby.tick();
    expect(r1.lobby.matches.get(id)!.moves[0].signature).toBeNull();
    await r1.stop();
    const r2 = referee(dir, { now, onChange, maxTimeouts: 2 });
    expect(r2.resumed).toBe(1);
    // Two more timeouts by the same seat: forfeit (no move logged). The archive write fails: the file stays.
    const m2 = r2.lobby.matches.get(id)!;
    const loser = 1 - m2.state!.active; // the seat that already timed out once
    t += 200_000; r2.lobby.tick(); // the seat on turn times out (its 1st)
    t += 200_000; r2.lobby.tick(); // loser's 2nd timeout → forfeit
    expect(m2.phase).toBe('ended');
    expect(m2.clock.timeouts[loser]).toBe(2);
    expect(readdirSync(join(dir, 'matches'))).toContain(`${id}.json`);
    await r2.api.server.close();
    // Next start: the archive works again; the finished match is archived and its running file goes.
    archiveWorks = true;
    const r3 = referee(dir, { now, onChange, maxTimeouts: 2 });
    expect(archived).toEqual([id]);
    expect(r3.lobby.matches.get(id)!.phase).toBe('ended');
    expect(r3.lobby.matches.get(id)!.result?.winner).toBe(m2.result?.winner);
    expect(readdirSync(join(dir, 'matches')).filter((f) => f.endsWith('.json'))).toEqual([]);
    await r3.api.server.close();
  }, 30_000);

  describe('a league charge in flight at the restart', () => {
    /** Two funded agents of different operators, paired and both revealed, with the charge left pending. */
    async function pendingLeagueMatch(dir: string) {
      const league = {
        entryFee: async () => 500_000n, currentWeek: async () => 1,
        balanceOf: async () => 5_000_000n,
        operatorOf: async (a: Address) => a, // every agent is its own operator
        start: () => new Promise<Hex>(() => {}), // never answers: the referee goes down mid-charge
        started: async () => false,
        cancel: async () => ('0x' + '00'.repeat(32)) as Hex,
        info: async () => ({ enabled: true }) as never,
      };
      const r1 = referee(dir, { league });
      const keys = [privateKeyToAccount(generatePrivateKey()).address, privateKeyToAccount(generatePrivateKey()).address];
      const shares = [('0x' + '01'.repeat(32)) as Hex, ('0x' + '02'.repeat(32)) as Hex];
      await r1.lobby.enqueue(keys[0], { mode: 'league', race: 'agents', seedCommit: commitSeed(shares[0]) as Hex }, true);
      const q = await r1.lobby.enqueue(keys[1], { mode: 'league', race: 'degens', seedCommit: commitSeed(shares[1]) as Hex }, true);
      const id = q.matchId!;
      r1.lobby.reveal(keys[0], id, shares[0], ('0x' + 'aa'.repeat(16)) as Hex);
      r1.lobby.reveal(keys[1], id, shares[1], ('0x' + 'bb'.repeat(16)) as Hex);
      expect(r1.lobby.matches.get(id)!.league?.state).toBe('charging');
      await r1.stop();
      return { id, league };
    }
    const settle = () => new Promise((r) => setTimeout(r, 20));

    it('counts as charged when the chain says it started (no second charge)', async () => {
      const dir = tmp();
      const { id, league } = await pendingLeagueMatch(dir);
      let starts = 0;
      const r2 = referee(dir, { league: { ...league, started: async () => true, start: async () => { starts++; return ('0x' + 'ee'.repeat(32)) as Hex; } } });
      r2.lobby.tick(); await settle();
      expect(starts).toBe(0);
      expect(r2.lobby.matches.get(id)!.league?.state).toBe('charged');
      expect(r2.lobby.matches.get(id)!.phase).toBe('active');
    });

    it('keeps waiting while the chain can’t be read, and only gives up after several "not started"', async () => {
      const dir = tmp();
      const { id, league } = await pendingLeagueMatch(dir);
      let t = 2_000_000;
      let rpcDown = true;
      const cancels: Hex[] = [];
      const r2 = referee(dir, {
        now: () => t,
        league: {
          ...league,
          started: async () => { if (rpcDown) throw new Error('rpc down'); return false; },
          start: async () => { throw new Error('rpc down'); },
          cancel: async (mid: Hex) => { cancels.push(mid); return mid; },
        },
      });
      const m = r2.lobby.matches.get(id)!;
      for (let i = 0; i < 5; i++) { r2.lobby.tick(); await settle(); t += 30_000; }
      expect(m.phase).toBe('reveal'); // unknown outcome: never cancelled
      expect(m.league?.state).toBe('charging');
      rpcDown = false; // the chain answers "not started" (the tx really failed)
      for (let i = 0; i < 6; i++) { r2.lobby.tick(); await settle(); t += 30_000; }
      expect(m.phase).toBe('cancelled');
      expect(m.league?.state).toBe('failed');
      expect(cancels).toEqual([]); // nothing was charged, nothing to refund
    });

    it('refunds a charge that lands after it was given up', async () => {
      const dir = tmp();
      const { id, league } = await pendingLeagueMatch(dir);
      let t = 2_000_000;
      let landed = false;
      const cancels: Hex[] = [];
      const r2 = referee(dir, {
        now: () => t,
        league: {
          ...league,
          started: async () => landed,
          start: async () => { throw new Error('receipt timeout'); },
          cancel: async (mid: Hex) => { cancels.push(mid); return mid; },
        },
      });
      const m = r2.lobby.matches.get(id)!;
      for (let i = 0; i < 6 && m.phase === 'reveal'; i++) { r2.lobby.tick(); await settle(); t += 30_000; }
      expect(m.phase).toBe('cancelled');
      expect(cancels).toEqual([]);
      landed = true; // the "timed out" transaction mines after all
      for (let i = 0; i < 3; i++) { r2.lobby.tick(); await settle(); t += 30_000; }
      expect(cancels).toEqual([id]); // both fees refunded, once
    });
  });
});
