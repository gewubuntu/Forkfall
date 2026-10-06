import { autoBuildSealed, SEALED_BOT_AFTER_MS, SEALED_RUN_DAYS, SEALED_WIDEN_MS, sealedPool, sealedPoolSeed } from '@forkfall/engine';
import { commitSeed, ForkfallClient, replayLog } from '@forkfall/sdk';
import type { AddressInfo } from 'node:net';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Chain } from '../src/chain.ts';
import { createApi } from '../src/http.ts';
import { Lobby } from '../src/lobby.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { Quests } from '../src/quests.ts';
import { Sealed } from '../src/sealed.ts';
import type { Match } from '../src/lobby/types.ts';

const A = '0x00000000000000000000000000000000000a11ce' as Address;
const B = '0x0000000000000000000000000000000000000b0b' as Address;
const C = '0x00000000000000000000000000000000000ca201' as Address;
const HOUSE = '0x00000000000000000000000000000000000000fe' as Address;
const DAY = 86_400_000;
const NOON = Date.UTC(2026, 9, 7, 12);
const share = ('0x' + '22'.repeat(32)) as Hex;
const commit = commitSeed(('0x' + '33'.repeat(32)) as Hex) as Hex;

function setup() {
  const clock = { t: NOON };
  const matches = new Map<Hex, Match>();
  let n = 0;
  const quests = new Quests({ chainId: 31337, rewarder: null, now: () => clock.t });
  const made: { players: string[]; runs: (string | null)[]; bot: boolean }[] = [];
  const sealed = new Sealed({
    chainId: 31337, quests, now: () => clock.t,
    host: {
      matches, houseAddress: HOUSE, eligibleFor: async () => false,
      sealedMatch: (players, runs) => {
        const id = ('0x' + (++n).toString(16).padStart(64, '0')) as Hex;
        const m = { id, phase: 'active', format: 'sealed', sealed: runs, players: players.map((p) => ({ ...p })) } as unknown as Match;
        matches.set(id, m);
        made.push({ players: players.map((p) => p.address), runs, bot: players.some((p) => !!p.bot) });
        return m;
      },
    },
  });
  /** Start a run and set the best deck for whoever it is. */
  const begin = (who: Address) => {
    sealed.start(who, share);
    const run = sealed.status(who).run!;
    const deck = autoBuildSealed(sealedPool(run.packs));
    return { run: sealed.setDeck(who, deck).run!, deck };
  };
  const end = (id: Hex, winner: Address | null) => {
    const m = matches.get(id)!;
    m.phase = 'ended';
    (m as { result?: unknown }).result = winner ? { winner } : undefined;
    sealed.recordMatch(m);
  };
  const after = (ms: number) => { clock.t += ms; };
  return { sealed, quests, matches, made, begin, end, after, clock };
}

const active = (s: Sealed, a: Address) => s.status(a).run!.activeMatch!.id as Hex;

describe('Sealed runs', () => {
  it('rolls the pool from the committed seed and reveals it when the run ends', () => {
    const { sealed, begin } = setup();
    const before = sealed.status(A).pending.commit;
    const { run } = begin(A);
    expect(run.commit).toBe(before);
    expect(run.serverSeed).toBeUndefined(); // hidden while the run is open
    expect(run.packs).toHaveLength(6);
    sealed.abandon(A);
    const done = sealed.status(A).history[0];
    expect(commitSeed(done.serverSeed as Hex)).toBe(done.commit); // the revealed seed matches the commitment
    expect(done.packs).toHaveLength(6);
    expect(sealedPoolSeed(done.serverSeed as Hex, done.share, done.id)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('allows one free run a day and one open run at a time', () => {
    const { sealed, begin, after } = setup();
    begin(A);
    expect(() => sealed.start(A, share)).toThrow(/open run/);
    sealed.abandon(A);
    expect(() => sealed.start(A, share)).toThrow(/one free run a day/);
    expect(sealed.status(A).canStart).toBe(false);
    after(DAY);
    expect(sealed.status(A).canStart).toBe(true);
    expect(() => sealed.start(A, share)).not.toThrow();
  });

  it('refuses decks outside the pool, and deck changes while queued', async () => {
    const { sealed, begin } = setup();
    const { deck } = begin(A);
    const run = sealed.status(A).run!;
    const pool = sealedPool(run.packs);
    const outside = [...Array(120).keys()].map((i) => i + 1).find((id) => !pool.has(id) && ![33, 34, 35, 36, 37, 38, 39, 40].includes(id))!;
    expect(() => sealed.setDeck(A, [outside, ...deck.slice(1)])).toThrow();
    expect(() => sealed.setDeck(A, deck.slice(1))).toThrow(/deck must have 30/);
    expect(() => sealed.setDeck(A, 'x')).toThrow(/list of card ids/);
    await sealed.enqueue(A, commit, false);
    expect(() => sealed.setDeck(A, deck)).toThrow(/leave the queue/);
    sealed.leave(A);
    expect(() => sealed.setDeck(A, deck)).not.toThrow();
  });

  it('needs a deck to queue', async () => {
    const { sealed } = setup();
    sealed.start(A, share);
    await expect(sealed.enqueue(A, commit, false)).rejects.toThrow(/build your deck/);
  });
});

describe('Sealed queue', () => {
  it('pairs the same record at once and holds a different record back until the window widens', async () => {
    const { sealed, begin, end, made, after } = setup();
    begin(A); begin(B); begin(C);
    await sealed.enqueue(A, commit, false); await sealed.enqueue(B, commit, false);
    sealed.tick();
    expect(made).toHaveLength(1);
    end(active(sealed, A), A); // A 1-0, B 0-1
    await sealed.enqueue(A, commit, false);
    await sealed.enqueue(C, commit, false); // C is 0-0: 1 step from A, 1 from B
    sealed.tick();
    expect(made).toHaveLength(1); // nobody within 0 steps yet
    after(SEALED_WIDEN_MS);
    sealed.tick();
    expect(made).toHaveLength(2);
    expect(made[1].bot).toBe(false);
  });

  it('plays a house bot after 45 s alone, and says when', async () => {
    const { sealed, begin, made, after } = setup();
    begin(A);
    const q = (await sealed.enqueue(A, commit, false)).run!.queued!;
    expect(q.botAt - q.since).toBe(SEALED_BOT_AFTER_MS);
    after(SEALED_BOT_AFTER_MS - 1000); sealed.tick();
    expect(made).toHaveLength(0);
    after(1000); sealed.tick();
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ bot: true, runs: [expect.any(String), null], players: [A, HOUSE] });
    expect(sealed.status(A).run!.queued).toBeNull();
    expect(sealed.status(A).run!.activeMatch).not.toBeNull();
  });
});

describe('Sealed results and prizes', () => {
  it('ends at 7 wins: 2 packs, the Unsealed title, one claim', async () => {
    const { sealed, begin, end, after } = setup();
    begin(A);
    for (let i = 0; i < 7; i++) {
      await sealed.enqueue(A, commit, false);
      after(SEALED_BOT_AFTER_MS); sealed.tick();
      const id = active(sealed, A);
      end(id, A);
      end(id, A); // a repeated notification never counts twice
    }
    const r = sealed.status(A).history[0];
    expect(r).toMatchObject({ state: 'finished', wins: 7, losses: 0, endedBy: 'wins' });
    expect(r.prize).toMatchObject({ scrap: 0, packs: 2, titleStep: true });
    expect(r.prize!.payout).toBeDefined();
    expect(sealed.titles(A)).toEqual(expect.arrayContaining(['title:sealed-rookie', 'title:unsealed']));
  });

  it('ends at 3 losses with the 0-win prize; a draw counts as a loss', async () => {
    const { sealed, begin, end, after } = setup();
    begin(A);
    for (let i = 0; i < 3; i++) {
      await sealed.enqueue(A, commit, false);
      after(SEALED_BOT_AFTER_MS); sealed.tick();
      end(active(sealed, A), i === 0 ? null : HOUSE);
    }
    const r = sealed.status(A).history[0];
    expect(r).toMatchObject({ wins: 0, losses: 3, endedBy: 'losses' });
    expect(r.prize).toMatchObject({ scrap: 50, packs: 0 });
  });

  it('pays nothing for an abandoned run with no match played', () => {
    const { sealed, begin } = setup();
    begin(A);
    sealed.abandon(A);
    const r = sealed.status(A).history[0];
    expect(r).toMatchObject({ endedBy: 'abandoned' });
    expect(r.prize).toBeNull();
    expect(sealed.titles(A)).toEqual([]);
  });

  it('expires a run left idle for 7 days and pays its record', async () => {
    const { sealed, begin, end, after } = setup();
    begin(A);
    await sealed.enqueue(A, commit, false);
    after(SEALED_BOT_AFTER_MS); sealed.tick();
    end(active(sealed, A), A);
    after(SEALED_RUN_DAYS * DAY + 1000); sealed.tick();
    const r = sealed.status(A).history[0];
    expect(r).toMatchObject({ endedBy: 'expired', wins: 1 });
    expect(r.prize).toMatchObject({ scrap: 50 });
  });

  it('catches up a match that ended while nobody was listening', async () => {
    const { sealed, begin, matches, after } = setup();
    begin(A);
    await sealed.enqueue(A, commit, false);
    after(SEALED_BOT_AFTER_MS); sealed.tick();
    const m = matches.get(active(sealed, A))!;
    m.phase = 'ended';
    (m as { result?: unknown }).result = { winner: A };
    expect(sealed.status(A).run!.wins).toBe(1); // status reconciles
  });

  it('a lost match record (cancelled) frees the run to queue again', async () => {
    const { sealed, begin, matches, after } = setup();
    begin(A);
    await sealed.enqueue(A, commit, false);
    after(SEALED_BOT_AFTER_MS); sealed.tick();
    matches.get(active(sealed, A))!.phase = 'cancelled';
    expect(sealed.status(A).run!.activeMatch).toBeNull();
    await expect(sealed.enqueue(A, commit, false)).resolves.toBeTruthy();
  });

  it('awards Sealed Veteran after three runs with 5+ wins', async () => {
    const { sealed, begin, end, after } = setup();
    for (let run = 0; run < 3; run++) {
      begin(A);
      for (let i = 0; i < 5; i++) {
        await sealed.enqueue(A, commit, false);
        after(SEALED_BOT_AFTER_MS); sealed.tick();
        end(active(sealed, A), A);
      }
      sealed.abandon(A);
      after(DAY);
    }
    expect(sealed.titles(A)).toContain('title:sealed-veteran');
  });
});

describe('Sealed persistence', () => {
  it('keeps runs, records and titles across a restart', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sealed-')), 'sealed.json');
    const mk = () => new Sealed({
      file, chainId: 31337, quests: new Quests({ chainId: 31337, rewarder: null }),
      host: { matches: new Map(), houseAddress: HOUSE, eligibleFor: async () => false, sealedMatch: () => { throw new Error('no'); } },
    });
    const one = mk();
    one.start(A, share);
    const id = one.status(A).run!.id;
    const packs = one.status(A).run!.packs;
    const two = mk();
    expect(two.status(A).run).toMatchObject({ id, packs });
    two.abandon(A);
    expect(mk().status(A).history[0].id).toBe(id);
  });
});

describe('Sealed over HTTP', () => {
  it('runs a whole match against the house bot through the real lobby', async () => {
    const clock = { t: NOON };
    const lobby = new Lobby({ chain: new Chain(null), house: privateKeyToAccount(generatePrivateKey()), now: () => clock.t });
    const quests = new Quests({ chainId: 31337, rewarder: null, now: () => clock.t });
    const sealed = new Sealed({
      chainId: 31337, quests, now: () => clock.t,
      host: { matches: lobby.matches, houseAddress: lobby.opts.house.address, sealedMatch: (p, r) => lobby.sealedMatch(p, r), eligibleFor: (a, ag) => lobby.eligibleFor(a, ag) },
    });
    lobby.onChange = (m) => { sealed.recordMatch(m); return true; };
    const { server } = createApi(lobby, { ratePerSec: 10_000, sealed, quests });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const me = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
      await me.connect();
      const s0 = await me.sealed();
      expect(s0).toMatchObject({ run: null, canStart: true });
      const started = await me.sealedStart();
      const deck = autoBuildSealed(sealedPool(started.run!.packs));
      await me.sealedDeck(deck);
      const queued = await me.sealedQueue(started.run!.id);
      expect(queued.run!.queued).not.toBeNull();
      clock.t += SEALED_BOT_AFTER_MS;
      sealed.tick();
      const st = await me.sealedStatus();
      const id = st.run!.activeMatch!.id as Hex;
      await me.reveal(id);
      for (let i = 0; i < 5; i++) await lobby.stepBots();
      await me.move(id, await me.state(id), { type: 'concede' });
      const after = await me.sealed();
      expect(after.run).toMatchObject({ wins: 0, losses: 1, activeMatch: null });
      expect(lobby.get(id).format).toBe('sealed');
      const log = await me.log(id);
      expect(log.format).toBe('sealed');
      expect(replayLog(log).ok).toBe(true); // the log verifies under the Sealed deck rules
    } finally { server.close(); }
  });
});
