import { dailyQuests, FIRST_WIN_SCRAP, questDay, type GameEvent } from '@forkfall/engine';
import { ForkfallClient, runMatch } from '@forkfall/sdk';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chain, type QuestRewarder } from '../src/chain.ts';
import { createApi } from '../src/http.ts';
import { Lobby } from '../src/lobby.ts';
import { finishedMatch, Quests, type FinishedMatch } from '../src/quests.ts';

const ALICE = '0x00000000000000000000000000000000000a11ce';
const BOB = '0x0000000000000000000000000000000000000b0b';
const NOON = Date.UTC(2026, 9, 7, 12); // a Wednesday
const DAY = questDay(NOON);

/** A finished match with enough events to complete every quest Alice has today. */
function match(id: string, opts: { winner?: 0 | 1 | 'draw'; turns?: number; at?: number; bot?: 'greedy' | 'random' } = {}): FinishedMatch {
  const ev: GameEvent[] = [];
  for (let i = 0; i < 12; i++) {
    ev.push({ t: 'play', seat: 0, cardId: 37, uid: 100 + i, ape: true }); // Bridge Runner: a Rush unit, Aped
    ev.push({ t: 'play', seat: 0, cardId: 36, uid: 200 + i }); // Liquidator: an action
    ev.push({ t: 'damage', seat: 1, uid: 'treasury', n: 3 });
    ev.push({ t: 'death', seat: 1, uid: 300 + i, cardId: 25 });
    ev.push({ t: 'predictionResolved', seat: 0, uid: 400 + i, cardId: 9, condition: 'attacks', hit: true });
    ev.push({ t: 'hold', seat: 0, uid: 500 + i });
    ev.push({ t: 'summon', seat: 0, uid: 600 + i, cardId: 1000 });
  }
  return {
    id, endedAt: opts.at ?? NOON, turns: opts.turns ?? 9, winner: opts.winner ?? 0, events: ev,
    players: [{ address: ALICE, race: 'agents', bot: null }, { address: BOB, race: 'degens', bot: opts.bot ?? null }],
  };
}

function fakeRewarder() {
  const sent: { player: string; claimId: Hex; scrap: number; packs: number }[] = [];
  let fail: string | null = null;
  const r: QuestRewarder = {
    async reward(player, claimId, scrap, _kind, packs) {
      if (fail) throw new Error(fail);
      if (sent.some((s) => s.claimId === claimId)) throw new Error('AlreadyClaimed');
      sent.push({ player, claimId, scrap, packs }); return ('0x' + 'ab'.repeat(32)) as Hex;
    },
    async claimed(id) { return sent.some((s) => s.claimId === id); },
  };
  return { r, sent, failWith: (m: string | null) => { fail = m; } };
}

describe('quest tracking', () => {
  it('counts a match for each real player, pays quests and the first win once, and ignores replays of the same match', () => {
    let now = NOON;
    const q = new Quests({ chainId: 31337, rewarder: fakeRewarder().r, now: () => now });
    const out = q.record(match('m1'));
    // Alice won with plenty of everything: up to 3 quests + first win; Bob lost (no first win).
    const alice = q.status(ALICE);
    expect(alice.firstWin).toMatchObject({ done: true, scrap: FIRST_WIN_SCRAP, payout: { state: 'pending' } });
    // What one match can finish depends on today's quests ("Play 3 matches" can't); the engine decides.
    const m1 = match('m1');
    const expected = dailyQuests(ALICE, DAY).filter((x) => x.progress({ seat: 0, won: true, race: 'agents', turns: 9, events: m1.events }) >= x.goal);
    expect(alice.quests.filter((x) => x.done).map((x) => x.id)).toEqual(expected.map((x) => x.id));
    expect(out.filter((p) => p.address === ALICE && p.kind === 'quest')).toHaveLength(expected.length);
    expect(q.status(BOB).firstWin.done).toBe(false);
    expect(q.record(match('m1'))).toEqual([]); // same match again (onChange fires more than once)
    expect(new Set(out.map((p) => p.claimId)).size).toBe(out.length);
    // Tomorrow is a fresh day.
    now += 86_400_000;
    expect(q.status(ALICE).quests.every((x) => x.progress === 0)).toBe(true);
    expect(q.status(ALICE).firstWin.done).toBe(false);
  });

  it('skips house bots, short matches, and matches from before the reset', () => {
    const q = new Quests({ chainId: 31337, now: () => NOON });
    const out = q.record(match('bot', { bot: 'greedy', winner: 1 }));
    expect(out.every((p) => p.address === ALICE)).toBe(true);
    expect(q.record(match('short', { turns: 7 }))).toEqual([]);
    q.record(match('today', { at: NOON }));
    expect(q.record(match('yesterday', { at: NOON - 86_400_000 }))).toEqual([]);
  });

  it('never counts matches from an earlier day, even for a player it has never seen (restored archives)', () => {
    const q = new Quests({ chainId: 31337, now: () => NOON });
    for (let d = 1; d <= 5; d++) expect(q.record(match(`old${d}`, { at: NOON - d * 86_400_000 }))).toEqual([]);
    expect(q.status(ALICE).pack.completed).toBe(0);
    // ...except a match that ends in the first minutes after midnight, for the day it was played.
    const justAfter = Date.UTC(2026, 9, 7, 0, 5);
    const q2 = new Quests({ chainId: 31337, now: () => justAfter });
    expect(q2.record(match('late', { at: justAfter - 6 * 60_000 })).length).toBeGreaterThan(0);
    const q3 = new Quests({ chainId: 31337, now: () => justAfter + 20 * 60_000 });
    expect(q3.record(match('late', { at: justAfter - 6 * 60_000 }))).toEqual([]);
  });

  it('a win against the easy random house bot counts as a match, not a win', () => {
    const q = new Quests({ chainId: 31337, now: () => NOON });
    const out = q.record(match('soft', { bot: 'random', winner: 0 }));
    expect(out.some((p) => p.kind === 'firstWin')).toBe(false);
    expect(q.status(ALICE).firstWin.done).toBe(false);
    const greedy = new Quests({ chainId: 31337, now: () => NOON });
    expect(greedy.record(match('hard', { bot: 'greedy', winner: 0 })).some((p) => p.kind === 'firstWin')).toBe(true);
  });

  it('rejects bad pack settings at startup', () => {
    expect(() => new Quests({ chainId: 1, periodDays: Number('x') })).toThrow(/period/);
    expect(() => new Quests({ chainId: 1, packGoal: 0 })).toThrow(/goal/);
    expect(() => new Quests({ chainId: 1, packKind: 300 })).toThrow(/kind/);
  });

  it('rerolls one unfinished quest a day', () => {
    const q = new Quests({ chainId: 31337, now: () => NOON });
    const before = q.status(ALICE).quests;
    const after = q.reroll(ALICE as Address, 1);
    expect(after.quests[1].id).not.toBe(before[1].id);
    expect(after.quests[1].id).toBe(dailyQuests(ALICE, DAY, [0, 1, 0])[1].id);
    expect(after.rerollsLeft).toBe(0);
    expect(() => q.reroll(ALICE as Address, 0)).toThrow(/no rerolls left/);
    const q2 = new Quests({ chainId: 31337, now: () => NOON });
    q2.record(match('m'));
    const done = q2.status(ALICE).quests.find((x) => x.done)!;
    expect(() => q2.reroll(ALICE as Address, done.slot)).toThrow(/already complete/);
    expect(() => q2.reroll(ALICE as Address, 7)).toThrow(/unknown quest slot/);
  });

  it('grants the free pack once the period goal is reached, weekly or biweekly', () => {
    let now = NOON;
    const q = new Quests({ chainId: 31337, packGoal: 3, now: () => now });
    const out = [];
    // Monday to Sunday of one week: a few matches a day until the goal is met.
    now = Date.UTC(2026, 9, 5, 12);
    for (let d = 0; d < 7 && q.status(ALICE).pack.completed < 3; d++, now += 86_400_000) {
      for (let k = 0; k < 3; k++) out.push(...q.record(match(`w${d}-${k}`, { at: now })));
    }
    const s = q.status(ALICE);
    expect(s.pack.completed).toBeGreaterThanOrEqual(3);
    expect(out.filter((p) => p.kind === 'pack' && p.address === ALICE)).toHaveLength(1);
    expect(out.find((p) => p.kind === 'pack')).toMatchObject({ packs: 1, scrap: 0 });
    expect(s.pack.payout?.state).toBe('offchain'); // no rewarder: recorded, not sent
    expect(s.paysOnChain).toBe(false);
    const biweekly = new Quests({ chainId: 31337, periodDays: 14, now: () => NOON });
    expect(biweekly.packGoal).toBe(20);
    expect(biweekly.status(ALICE).pack.endsAt - biweekly.status(ALICE).pack.startsAt).toBe(14 * 86_400_000);
  });

  it('pays on-chain, retries failures with backoff, treats "already claimed" as paid, and persists', async () => {
    let now = NOON;
    const file = join(mkdtempSync(join(tmpdir(), 'ff-quests-')), 'q.json');
    const f = fakeRewarder();
    const q = new Quests({ chainId: 31337, rewarder: f.r, file, now: () => now });
    const out = q.record(match('p1'));
    f.failWith('rpc down');
    const r1 = await q.payDue();
    expect(r1.failed.length).toBe(out.length);
    expect((await q.payDue()).failed).toEqual([]); // backing off
    f.failWith(null);
    now += 120_000;
    const r2 = await q.payDue();
    expect(r2.paid.length).toBe(out.length);
    expect(f.sent.reduce((a, s) => a + s.scrap, 0)).toBe(out.reduce((a, p) => a + p.scrap, 0));
    expect(q.status(ALICE).firstWin.payout).toMatchObject({ state: 'paid' });
    // A payout that already landed (e.g. the receipt was lost) is marked paid, not paid twice.
    const reloaded = new Quests({ chainId: 31337, rewarder: f.r, file, now: () => now });
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    expect(stored.payouts.every((p: { state: string }) => p.state === 'paid')).toBe(true);
    expect(reloaded.status(ALICE).firstWin.payout?.state).toBe('paid');
  });

  it('stops retrying a payout the contract will never accept', async () => {
    const f = fakeRewarder();
    const q = new Quests({ chainId: 31337, rewarder: f.r, now: () => NOON });
    q.record(match('perm'));
    f.failWith('UnknownKind(9)');
    const r = await q.payDue();
    expect(r.failed.every((p) => p.state === 'failed')).toBe(true);
    expect(q.status(ALICE).firstWin.payout?.state).toBe('failed');
    f.failWith(null);
    expect((await q.payDue()).paid).toEqual([]); // not retried
  });
});

describe('quests over HTTP', () => {
  const quests = new Quests({ chainId: 31337 });
  const lobby = new Lobby({ chain: new Chain(null), house: privateKeyToAccount(generatePrivateKey()) });
  lobby.onChange = (m) => { const f = finishedMatch(m); if (f) quests.record(f); };
  const { server } = createApi(lobby, { ratePerSec: 10_000, quests });
  let url = '';
  beforeAll(async () => { await new Promise<void>((r) => server.listen(0, r)); url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
  afterAll(() => server.close());

  it('a practice match against the house bot counts toward your quests', async () => {
    const c = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
    await c.connect({ agent: true });
    const before = await c.quests();
    expect(before.quests).toHaveLength(3);
    expect(before.paysOnChain).toBe(false);
    const id = await c.practice({ race: 'agents', botRace: 'brokers', bot: 'greedy' });
    const loop = runMatch(c, id, { pollMs: 5 });
    for (let i = 0; i < 4000 && lobby.get(id).phase !== 'ended'; i++) {
      await lobby.stepBots();
      await new Promise((r) => setTimeout(r, 2));
    }
    expect((await loop).phase).toBe('ended');
    const after = await c.quests();
    const play = after.quests.some((q) => q.progress > 0) || after.firstWin.done;
    expect(play).toBe(true);
    // Public by address; reroll needs a session.
    expect((await (await fetch(`${url}/v1/quests?address=${c.address}`)).json()).day).toBe(after.day);
    expect((await fetch(`${url}/v1/quests/reroll`, { method: 'POST', body: '{"slot":0}' })).status).toBe(401);
    const unfinished = after.quests.find((q) => !q.done);
    if (unfinished) expect((await c.rerollQuest(unfinished.slot)).rerollsLeft).toBe(0);
  });
});
