import {
  dailyQuests, PASS_TIERS, PASS_TIERS_TABLE, PASS_XP_PER_TIER, questDay, XP_BOT_DAILY_CAP, XP_FIRST_WIN, XP_MATCH_DAILY_CAP, XP_QUEST,
  type GameEvent,
} from '@forkfall/engine';
import type { AddressInfo } from 'node:net';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { Chain, type QuestRewarder } from '../src/chain.ts';
import { createApi } from '../src/http.ts';
import { Lobby } from '../src/lobby.ts';
import { Profiles } from '../src/profiles.ts';
import { Quests, type FinishedMatch } from '../src/quests.ts';

const ALICE = '0x00000000000000000000000000000000000a11ce';
const BOB = '0x0000000000000000000000000000000000000b0b';
const DAY_MS = 86_400_000;
const NOON = Date.UTC(2026, 9, 7, 12); // Wednesday of pass season 1 (5 Oct to 1 Nov 2026)

/** A finished match Alice wins, with enough events to finish most of her quests. */
function match(id: string, at = NOON, winner: 0 | 1 = 0): FinishedMatch {
  const ev: GameEvent[] = [];
  for (let i = 0; i < 12; i++) {
    ev.push({ t: 'play', seat: 0, cardId: 37, uid: 100 + i, ape: true });
    ev.push({ t: 'play', seat: 0, cardId: 36, uid: 200 + i });
    ev.push({ t: 'damage', seat: 1, uid: 'treasury', n: 3 });
    ev.push({ t: 'death', seat: 1, uid: 300 + i, cardId: 25 });
    ev.push({ t: 'predictionResolved', seat: 0, uid: 400 + i, cardId: 9, condition: 'attacks', hit: true });
    ev.push({ t: 'hold', seat: 0, uid: 500 + i });
    ev.push({ t: 'summon', seat: 0, uid: 600 + i, cardId: 1000 });
  }
  return {
    id, endedAt: at, turns: 9, winner, events: ev,
    players: [{ address: ALICE, race: 'agents', bot: null }, { address: BOB, race: 'degens', bot: null }],
  };
}

function fakeRewarder() {
  const sent: { player: string; claimId: Hex; scrap: number; packs: number }[] = [];
  const r: QuestRewarder = {
    async reward(player, claimId, scrap, _kind, packs) {
      if (sent.some((s) => s.claimId === claimId)) throw new Error('AlreadyClaimed');
      sent.push({ player, claimId, scrap, packs }); return ('0x' + 'cd'.repeat(32)) as Hex;
    },
    async claimed(id) { return sent.some((s) => s.claimId === id); },
  };
  return { r, sent };
}

/** Plays `perDay` matches a day for `days` days from `start`, so XP builds up the way it does for a regular player. */
function playDays(q: Quests, clock: { t: number }, days: number, perDay = 15, start = NOON) {
  for (let d = 0; d < days; d++) {
    clock.t = start + d * DAY_MS;
    for (let i = 0; i < perDay; i++) q.record(match(`d${d}-m${i}`, clock.t));
  }
}

describe('season pass XP', () => {
  it('earns XP for matches, wins, quests and the first win, and caps match XP per day', () => {
    const clock = { t: NOON };
    const q = new Quests({ chainId: 31337, now: () => clock.t });
    q.record(match('m1'));
    const m1 = match('m1');
    const done = (who: string, seat: 0 | 1, won: boolean) => dailyQuests(who, questDay(NOON))
      .filter((x) => x.progress({ seat, won, race: seat ? 'degens' : 'agents', turns: 9, events: m1.events }) >= x.goal).length;
    expect(q.passStatus(ALICE).xp).toBe(35 + done(ALICE, 0, true) * XP_QUEST + XP_FIRST_WIN);
    expect(q.passStatus(BOB).xp).toBe(20 + done(BOB, 1, false) * XP_QUEST);

    for (let i = 2; i <= 20; i++) q.record(match(`m${i}`));
    const alice = q.passStatus(ALICE);
    expect(alice).toMatchObject({ season: 1, matchXpToday: XP_MATCH_DAILY_CAP, matchXpCap: XP_MATCH_DAILY_CAP, premium: null });
    expect(alice.tier).toBe(Math.floor(alice.xp / PASS_XP_PER_TIER));
    clock.t += DAY_MS;
    expect(q.passStatus(ALICE).matchXpToday).toBe(0); // a new day, a new cap
  });

  it('counts matches against house bots for less: lower match XP with its own cap, half quest and first-win XP', () => {
    const clock = { t: NOON };
    const q = new Quests({ chainId: 31337, now: () => clock.t });
    const vsBot = (id: string, kind = 'standard') => {
      const m = match(id, clock.t);
      m.players[1] = { address: BOB, race: 'degens', bot: kind };
      return m;
    };
    q.record(vsBot('b1'));
    const done = dailyQuests(ALICE, questDay(NOON))
      .filter((x) => x.progress({ seat: 0, won: true, race: 'agents', turns: 9, events: match('x').events }) >= x.goal).length;
    expect(q.passStatus(ALICE).xp).toBe(15 + done * XP_QUEST / 2 + XP_FIRST_WIN / 2);
    for (let i = 2; i <= 20; i++) q.record(vsBot(`b${i}`));
    expect(q.passStatus(ALICE)).toMatchObject({ matchXpToday: XP_BOT_DAILY_CAP, botXpToday: XP_BOT_DAILY_CAP, botXpCap: XP_BOT_DAILY_CAP });
    const before = q.passStatus(ALICE).xp;
    q.record(vsBot('b21', 'random')); // the easy bot: no win, and the bot cap is spent anyway
    expect(q.passStatus(ALICE).xp).toBe(before);
    q.record(match('h1', clock.t)); // a real opponent still earns full match XP after the bot cap
    expect(q.passStatus(ALICE).xp).toBe(before + 35);
  });

  it('cannot finish the pass in a season playing only bots, but makes real progress', () => {
    const clock = { t: Date.UTC(2026, 9, 5, 12) }; // the first day of season 1
    const q = new Quests({ chainId: 31337, now: () => clock.t });
    for (let d = 0; d < 28; d++) {
      clock.t = Date.UTC(2026, 9, 5, 12) + d * DAY_MS;
      for (let i = 0; i < 30; i++) {
        const m = match(`d${d}-b${i}`, clock.t);
        m.players[1] = { address: BOB, race: 'degens', bot: 'strong' };
        q.record(m);
      }
    }
    const tier = q.passStatus(ALICE).tier;
    expect(tier).toBeGreaterThanOrEqual(15);
    expect(tier).toBeLessThan(PASS_TIERS);
  });

  it('queues each free tier reward once as it is reached, with its own claim id, and unlocks the title at tier 30', () => {
    const clock = { t: NOON };
    const q = new Quests({ chainId: 31337, rewarder: fakeRewarder().r, now: () => clock.t });
    playDays(q, clock, 24);
    const s = q.passStatus(ALICE);
    expect(s.tier).toBe(PASS_TIERS);
    const paying = PASS_TIERS_TABLE.filter((t) => t.free && (t.free.scrap || t.free.packs));
    for (const t of paying) expect(s.tiers[t.tier - 1].freePayout?.state, `tier ${t.tier}`).toBe('pending');
    expect(s.tiers.filter((t) => t.premiumPayout)).toEqual([]); // no premium pass on this server
    expect(q.passCosmetics(ALICE)).toEqual(['title:season-1']);
    // Recording more never re-queues a tier.
    const before = s.tiers.map((t) => t.freePayout?.state);
    q.record(match('extra', clock.t));
    expect(q.passStatus(ALICE).tiers.map((t) => t.freePayout?.state)).toEqual(before);
  });

  it('pays premium tiers already reached once the pass is bought, and keeps checking until it is', async () => {
    const clock = { t: NOON };
    let bought = false;
    const reads: number[] = [];
    const { r, sent } = fakeRewarder();
    const q = new Quests({
      chainId: 31337, rewarder: r, now: () => clock.t,
      passHolder: async (a, season) => { reads.push(season); return bought && a.toLowerCase() === ALICE; },
    });
    playDays(q, clock, 3);
    const tier = q.passStatus(ALICE).tier;
    expect(tier).toBeGreaterThan(1);
    expect(q.passStatus(ALICE).premium).toBe(false);
    expect(await q.syncPremium(ALICE)).toBe(false);
    expect(await q.syncPremium(ALICE)).toBe(false); // within the recheck window: no second read
    expect(reads).toEqual([1]);

    bought = true;
    expect(await q.syncPremium(ALICE, true)).toBe(false); // a forced read still waits 10 s after the last one
    clock.t += 10_000;
    expect(await q.syncPremium(ALICE, true)).toBe(true);
    const s = q.passStatus(ALICE);
    expect(s.premium).toBe(true);
    for (let t = 2; t <= tier; t++) expect(s.tiers[t - 1].premiumPayout?.state, `tier ${t}`).toBe('pending');
    expect(s.tiers[0].premiumPayout).toBeUndefined(); // tier 1 is the card back: nothing to pay
    expect(q.passCosmetics(ALICE)).toContain('back:season-1');
    await q.syncPremium(ALICE, true); // idempotent

    const paid = await q.payDue();
    const passPaid = paid.paid.filter((p) => p.kind === 'pass');
    expect(new Set(passPaid.map((p) => p.claimId)).size).toBe(passPaid.length);
    expect(sent.filter((x) => x.player === ALICE).length).toBeGreaterThanOrEqual(passPaid.length);
    const premiumScrap = PASS_TIERS_TABLE.slice(1, tier).reduce((a, t) => a + (t.premium?.scrap ?? 0), 0);
    expect(passPaid.filter((p) => p.ref.includes('-premium-')).reduce((a, p) => a + p.scrap, 0)).toBe(premiumScrap);
  });

  it('pays a premium pass bought in the last minutes of a season, after the season has ended', async () => {
    const clock = { t: NOON };
    let bought = false;
    let rpcDown = false;
    const reads: number[] = [];
    const { r, sent } = fakeRewarder();
    const q = new Quests({
      chainId: 31337, rewarder: r, now: () => clock.t,
      passHolder: async (a, season) => {
        if (rpcDown) throw new Error('rpc down');
        reads.push(season); return bought && season === 1 && a.toLowerCase() === ALICE;
      },
    });
    playDays(q, clock, 24);
    expect(q.passStatus(ALICE).tier).toBe(PASS_TIERS);
    clock.t = Date.UTC(2026, 10, 1, 23, 58); // the last minutes of season 1
    await q.payDue(); // checked: no pass yet
    bought = true; // bought at 23:59, inside the 5-minute recheck window
    rpcDown = true; // and the RPC is down across midnight
    clock.t = Date.UTC(2026, 10, 2, 0, 1);
    await q.payDue();
    expect(q.passCosmetics(ALICE)).not.toContain('back:season-1'); // not seen yet, but not given up on either
    rpcDown = false;
    clock.t += 5 * 60_000;
    await q.payDue();
    expect(reads.at(-1)).toBe(1); // read season 1, not the new season
    expect(q.passCosmetics(ALICE)).toEqual(expect.arrayContaining(['back:season-1', 'badge:season-1']));
    await q.payDue();
    const premium = PASS_TIERS_TABLE.reduce((a, t) => ({ scrap: a.scrap + (t.premium?.scrap ?? 0), packs: a.packs + (t.premium?.packs ?? 0) }), { scrap: 0, packs: 0 });
    const free = PASS_TIERS_TABLE.reduce((a, t) => ({ scrap: a.scrap + (t.free?.scrap ?? 0), packs: a.packs + (t.free?.packs ?? 0) }), { scrap: 0, packs: 0 });
    const got = sent.filter((x) => x.player === ALICE && q['data'].payouts.some((p: { claimId: Hex; kind: string }) => p.claimId === x.claimId && p.kind === 'pass'));
    expect(got.reduce((a, x) => a + x.packs, 0)).toBe(premium.packs + free.packs);
    expect(got.reduce((a, x) => a + x.scrap, 0)).toBe(premium.scrap + free.scrap);
    const n = reads.length;
    clock.t += 60 * 60_000;
    await q.payDue();
    expect(reads.length).toBe(n); // the ended season is settled: no more reads for it
  });

  it('reads premium passes a bounded number of times: backs off when the RPC fails, at most 20 per tick', async () => {
    const clock = { t: NOON };
    let reads = 0;
    const q = new Quests({
      chainId: 31337, rewarder: fakeRewarder().r, now: () => clock.t,
      passHolder: async () => { reads++; throw new Error('rpc down'); },
    });
    playDays(q, clock, 1); // Alice and Bob both pass tier 1
    for (let i = 0; i < 10; i++) { await q.payDue(); clock.t += 5_000; }
    expect(reads).toBe(2); // one read each, then they wait out the recheck window (not one per tick)

    // 50 more players at tier 1 or above: a tick reads at most 20 of them, and the next tick moves on.
    for (let n = 0; n < 50; n++) {
      const a = `0x${(0xc000 + n).toString(16).padStart(40, '0')}`;
      const m = match(`p${n}`, clock.t);
      m.players = [{ address: a, race: 'agents', bot: null }, { address: BOB, race: 'degens', bot: null }];
      for (let k = 0; k < 10; k++) q.record({ ...m, id: `p${n}-${k}` });
    }
    reads = 0;
    await q.payDue();
    expect(reads).toBe(20);
    await q.payDue();
    expect(reads).toBe(40);
  });

  it('starts every season from zero but keeps the cosmetics earned before', () => {
    const clock = { t: NOON };
    const q = new Quests({ chainId: 31337, now: () => clock.t });
    playDays(q, clock, 24);
    expect(q.passStatus(ALICE).tier).toBe(PASS_TIERS);
    clock.t = Date.UTC(2026, 10, 3, 12); // season 2
    const s = q.passStatus(ALICE);
    expect(s).toMatchObject({ season: 2, xp: 0, tier: 0 });
    q.record(match('s2', clock.t));
    expect(q.passStatus(ALICE).xp).toBeGreaterThan(0);
    expect(q.passCosmetics(ALICE)).toContain('title:season-1');
  });

  it('lets a player equip season cosmetics only once earned', async () => {
    const clock = { t: NOON };
    const q = new Quests({ chainId: 31337, now: () => clock.t });
    const profiles = new Profiles(undefined, async () => new Map());
    profiles.passUnlocked = (a) => q.passCosmetics(a);
    await expect(profiles.equip(ALICE as Address, { title: 'title:season-1' })).rejects.toThrow(/locked: Reach tier 30 of the season 1 pass/);
    playDays(q, clock, 24);
    const p = await profiles.equip(ALICE as Address, { title: 'title:season-1' });
    expect(p.title).toBe('title:season-1');
    await expect(profiles.equip(ALICE as Address, { cardBack: 'back:season-1' })).rejects.toThrow(/locked/); // premium only
  });
});

describe('season pass over HTTP', () => {
  it('serves the SeasonPass address with the hub contracts, and pass progress by address', async () => {
    const book = { chainId: 31337, SeasonPass: '0x00000000000000000000000000000000000005ea', PackSale: '0x00000000000000000000000000000000000000ac' };
    const lobby = new Lobby({ chain: new Chain(book as never), house: privateKeyToAccount(generatePrivateKey()) });
    const clock = { t: NOON };
    const quests = new Quests({ chainId: 31337, now: () => clock.t });
    quests.record(match('h1'));
    const { server } = createApi(lobby, { ratePerSec: 10_000, quests });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const config = await (await fetch(`${url}/v1/config`)).json();
      expect(config.contracts.SeasonPass).toBe(book.SeasonPass);
      const pass = await (await fetch(`${url}/v1/pass?address=${ALICE}`)).json();
      expect(pass).toMatchObject({ season: 1, xp: quests.passStatus(ALICE).xp, premium: null });
      expect((await fetch(`${url}/v1/pass`)).status).toBe(400); // no address, no session
    } finally { server.close(); }
  });

  it('makes no chain reads for a pass that is not your own, even with sync=1', async () => {
    const lobby = new Lobby({ chain: new Chain({ chainId: 31337 } as never), house: privateKeyToAccount(generatePrivateKey()) });
    let reads = 0;
    const quests = new Quests({
      chainId: 31337, now: () => NOON,
      passHolder: async () => { reads++; return false; },
      eligible: async () => { reads++; return true; },
    });
    quests.record(match('h1'));
    const { server } = createApi(lobby, { ratePerSec: 10_000, quests });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (let i = 0; i < 5; i++) {
        const pass = await (await fetch(`${url}/v1/pass?address=${ALICE}&sync=1`)).json();
        expect(pass).toMatchObject({ season: 1, premium: false });
        expect(pass.eligible).toBeUndefined();
      }
      expect(reads).toBe(0);
    } finally { server.close(); }
  });
});
