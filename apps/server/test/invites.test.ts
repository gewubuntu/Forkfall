import { REFERRAL_CAP, REFERRAL_DAYS, REFERRAL_MATCHES } from '@forkfall/engine';
import { ForkfallClient } from '@forkfall/sdk';
import type { AddressInfo } from 'node:net';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { Chain, type GiftDeliverer, type HeldGift, type QuestRewarder } from '../src/chain.ts';
import { createApi } from '../src/http.ts';
import { Invites } from '../src/invites.ts';
import { Lobby } from '../src/lobby.ts';
import { Quests, type FinishedMatch } from '../src/quests.ts';

const ALICE = '0x00000000000000000000000000000000000a11ce';
const BOB = '0x0000000000000000000000000000000000000b0b';
const CAROL = '0x00000000000000000000000000000000000ca201';
const DAY_MS = 86_400_000;
const NOON = Date.UTC(2026, 9, 7, 12);

let n = 0;
const match = (a: string, b: string, at: number, opts: { turns?: number; challenge?: string; bot?: boolean } = {}): FinishedMatch => ({
  id: `m${++n}`, endedAt: at, turns: opts.turns ?? 9, winner: 0, events: [],
  players: [{ address: a, race: 'agents', bot: null }, { address: b, race: 'degens', bot: opts.bot ? 'greedy' : null }],
  ...(opts.challenge ? { challenge: opts.challenge } : {}),
});

function fakeRewarder() {
  const sent: { player: string; claimId: Hex; packKind: number; packs: number }[] = [];
  const r: QuestRewarder = {
    async reward(player, claimId, _scrap, packKind, packs) {
      if (sent.some((s) => s.claimId === claimId)) throw new Error('AlreadyClaimed');
      sent.push({ player, claimId, packKind, packs }); return ('0x' + 'ab'.repeat(32)) as Hex;
    },
    async claimed(id) { return sent.some((s) => s.claimId === id); },
  };
  return { r, sent };
}

function setup(opts: { played?: string[]; verified?: string[]; gifts?: GiftDeliverer } = {}) {
  const clock = { t: NOON };
  const { r, sent } = fakeRewarder();
  const verified = new Set(opts.verified ?? []);
  const eligible = async (a: Address) => verified.has(a.toLowerCase());
  const quests = new Quests({ chainId: 31337, rewarder: r, eligible, now: () => clock.t });
  const played = new Set(opts.played ?? []);
  const invites = new Invites({
    chainId: 31337, quests, eligible, gifts: opts.gifts, now: () => clock.t, hasPlayed: (a) => played.has(a.toLowerCase()),
  });
  return { clock, quests, invites, sent, verified, played };
}

describe('referrals', () => {
  it('counts only wallets that never played, once, and never yourself', () => {
    const { invites } = setup({ played: [CAROL] });
    expect(invites.invite(BOB, ALICE, 'link')).toBe(true);
    expect(invites.invite(BOB, CAROL, 'link')).toBe(false); // already invited
    expect(invites.invite(CAROL, ALICE, 'link')).toBe(false); // has played before
    expect(invites.invite(ALICE, ALICE, 'link')).toBe(false);
    expect(invites.invite(ALICE, 'nope', 'link')).toBe(false);
    expect(invites.status(ALICE).invited.map((i) => i.invited)).toEqual([BOB]);
    expect(invites.status(BOB).invitedBy).toMatchObject({ inviter: ALICE, matches: 0, goal: REFERRAL_MATCHES, state: 'playing' });
  });

  it('pays both a Set 1 pack once the invited player has played enough and verified', async () => {
    const { clock, invites, quests, sent, verified } = setup();
    invites.invite(BOB, ALICE, 'link');
    invites.record(match(BOB, CAROL, clock.t, { turns: 3 })); // too short to count
    for (let i = 0; i < REFERRAL_MATCHES - 1; i++) invites.record(match(BOB, CAROL, clock.t, { bot: i === 0 }));
    expect(invites.status(BOB).invitedBy).toMatchObject({ matches: REFERRAL_MATCHES - 1, state: 'playing' });
    invites.record(match(CAROL, BOB, clock.t)); // either seat
    expect(invites.status(BOB).invitedBy?.state).toBe('verifying');

    await invites.tick(); // Bob hasn't verified: nothing paid
    expect(invites.status(BOB).invitedBy?.state).toBe('verifying');
    clock.t += 60_000;
    verified.add(BOB);
    await invites.tick(); // still inside the recheck window
    expect(invites.status(BOB).invitedBy?.state).toBe('verifying');
    clock.t += 5 * 60_000;
    expect((await invites.tick()).paid).toEqual([BOB]);
    expect(invites.status(BOB).invitedBy).toMatchObject({ state: 'paid', payout: { state: 'pending' } });

    verified.add(ALICE);
    await quests.payDue();
    expect(sent.map((s) => [s.player, s.packKind, s.packs]).sort()).toEqual([[ALICE, 0, 1], [BOB, 0, 1]].sort());
    expect(new Set(sent.map((s) => s.claimId)).size).toBe(2);
    expect(invites.status(ALICE).invited[0]).toMatchObject({ state: 'paid', capped: false, payout: { state: 'paid' } });
    expect(invites.status(ALICE).paidThisSeason).toBe(1);

    await invites.tick(); // paid once
    await quests.payDue();
    expect(sent).toHaveLength(2);
  });

  it('holds the inviter\'s pack until the inviter verifies, like any reward', async () => {
    const { clock, invites, quests, sent, verified } = setup({ verified: [BOB] });
    invites.invite(BOB, ALICE, 'challenge');
    for (let i = 0; i < REFERRAL_MATCHES; i++) invites.record(match(BOB, CAROL, clock.t));
    await invites.tick();
    await quests.payDue();
    expect(sent.map((s) => s.player)).toEqual([BOB]);
    expect(invites.status(ALICE).invited[0].payout?.state).toBe('held');
    verified.add(ALICE);
    quests.releaseHeld(ALICE);
    await quests.payDue();
    expect(sent.map((s) => s.player).sort()).toEqual([ALICE, BOB].sort());
  });

  it('expires when the matches come too late, and ignores matches from before the invite', async () => {
    const { clock, invites } = setup({ verified: [BOB] });
    invites.record(match(BOB, CAROL, clock.t)); // before any invite: unrelated
    invites.invite(BOB, ALICE, 'link');
    invites.record({ ...match(BOB, CAROL, clock.t - 1), id: 'earlier' }); // ended before the invite
    expect(invites.status(BOB).invitedBy?.matches).toBe(0);
    clock.t += (REFERRAL_DAYS * DAY_MS) + 1;
    for (let i = 0; i < REFERRAL_MATCHES; i++) invites.record(match(BOB, CAROL, clock.t));
    expect(invites.status(BOB).invitedBy?.matches).toBe(0);
    await invites.tick();
    expect(invites.status(BOB).invitedBy?.state).toBe('expired');
  });

  it(`pays an inviter for at most ${REFERRAL_CAP} referrals a season; the invited players are all paid`, async () => {
    const friends = Array.from({ length: REFERRAL_CAP + 2 }, (_, i) => `0x${(0xf000 + i).toString(16).padStart(40, '0')}`);
    const { clock, invites, quests, sent } = setup({ verified: [ALICE, ...friends] });
    for (const f of friends) {
      invites.invite(f, ALICE, 'link');
      for (let i = 0; i < REFERRAL_MATCHES; i++) invites.record(match(f, CAROL, clock.t));
    }
    await invites.tick();
    for (let i = 0; i < 3; i++) await quests.payDue();
    expect(sent.filter((s) => s.player === ALICE)).toHaveLength(REFERRAL_CAP);
    expect(sent.filter((s) => friends.includes(s.player))).toHaveLength(friends.length);
    const s = invites.status(ALICE);
    expect(s.paidThisSeason).toBe(REFERRAL_CAP);
    expect(s.invited.filter((i) => i.capped)).toHaveLength(2);
  });

  it('keeps referrals across a restart (file)', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const file = join(mkdtempSync(join(tmpdir(), 'invites-')), 'invites.json');
    const quests = new Quests({ chainId: 1, now: () => NOON });
    const a = new Invites({ file, chainId: 1, quests, now: () => NOON, hasPlayed: () => false });
    a.invite(BOB, ALICE, 'link');
    a.record(match(BOB, CAROL, NOON));
    const b = new Invites({ file, chainId: 1, quests, now: () => NOON, hasPlayed: () => false });
    expect(b.status(BOB).invitedBy).toMatchObject({ inviter: ALICE, matches: 1 });
    expect(b.setAside).toBeNull();
  });
});

describe('challenge gifts', () => {
  function fakeGifts() {
    const held = new Map<Hex, HeldGift>();
    const delivered: { id: Hex; to: Address }[] = [];
    let failNext = '';
    const g: GiftDeliverer = {
      async read(id) { return held.get(id) ?? { from: '0x0000000000000000000000000000000000000000', kind: 0, count: 0, state: 'none', refundableAt: 0 }; },
      async deliver(id, to) {
        if (failNext) { const m = failNext; failNext = ''; throw new Error(m); }
        const h = held.get(id);
        if (h?.state !== 'held') throw new Error('NotHeld');
        h.state = 'delivered'; delivered.push({ id, to }); return ('0x' + 'dd'.repeat(32)) as Hex;
      },
    };
    const hold = (id: Hex, from: string, count = 2) => held.set(id, { from: from as Address, kind: 0, count, state: 'held', refundableAt: NOON + 3 * DAY_MS });
    return { g, held, delivered, hold, fail: (m: string) => { failNext = m; } };
  }

  it('issues a gift id to the challenger, confirms the payment and delivers to whoever played', async () => {
    const f = fakeGifts();
    const { clock, invites } = setup({ gifts: f.g });
    const v = await invites.attachGift('code1', ALICE);
    expect(v).toMatchObject({ state: 'unpaid', giftId: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(invites.giftView('code1', BOB)).toBeUndefined(); // nothing to show the friend before it's paid
    expect((await invites.attachGift('code1', ALICE)).giftId).toBe(v.giftId); // one id per challenge
    await expect(invites.attachGift('code1', BOB)).rejects.toThrow(/only the challenger/);

    f.hold(v.giftId!, ALICE);
    expect(await invites.attachGift('code1', ALICE)).toMatchObject({ state: 'held', count: 2 });
    expect(invites.giftView('code1', BOB)).toMatchObject({ state: 'held', count: 2, from: ALICE });
    expect(invites.giftView('code1', BOB)?.giftId).toBeUndefined();

    invites.record(match(ALICE, BOB, clock.t, { challenge: 'code1', turns: 1 })); // any finished match, even a short one
    expect(invites.giftView('code1', ALICE)).toMatchObject({ state: 'due', to: BOB });
    const r = await invites.tick();
    expect(r.delivered).toHaveLength(1);
    expect(f.delivered).toEqual([{ id: v.giftId, to: BOB }]);
    expect(invites.giftView('code1', BOB)).toMatchObject({ state: 'delivered', tx: expect.stringMatching(/^0x/) });
    await invites.tick();
    expect(f.delivered).toHaveLength(1);
  });

  it('ignores a gift someone else held under the id, and settles one paid only after the match', async () => {
    const f = fakeGifts();
    const { clock, invites } = setup({ gifts: f.g });
    const a = await invites.attachGift('c-a', ALICE);
    f.hold(a.giftId!, CAROL); // someone with the link front-ran the id
    expect((await invites.attachGift('c-a', ALICE)).state).toBe('none');
    invites.record(match(ALICE, BOB, clock.t, { challenge: 'c-a' }));
    await invites.tick();
    expect(f.delivered).toHaveLength(0);

    const b = await invites.attachGift('c-b', ALICE);
    invites.record(match(ALICE, BOB, clock.t, { challenge: 'c-b' })); // played before the payment was confirmed
    f.hold(b.giftId!, ALICE);
    await invites.tick();
    expect(f.delivered).toEqual([{ id: b.giftId, to: BOB }]);

    const c = await invites.attachGift('c-c', ALICE); // never paid at all
    invites.record(match(ALICE, BOB, clock.t, { challenge: 'c-c' }));
    await invites.tick();
    expect(invites.giftView('c-c', ALICE)?.state).toBe('none');
    expect(c.state).toBe('unpaid');
  });

  it('retries a failed delivery, and adopts a refund that beat it', async () => {
    const f = fakeGifts();
    const { clock, invites } = setup({ gifts: f.g });
    const v = await invites.attachGift('c1', ALICE);
    f.hold(v.giftId!, ALICE);
    await invites.attachGift('c1', ALICE);
    invites.record(match(BOB, ALICE, clock.t, { challenge: 'c1' }));
    f.fail('nonce too low');
    expect((await invites.tick()).failed).toHaveLength(1);
    expect(invites.giftView('c1', ALICE)?.state).toBe('due');
    await invites.tick(); // backing off
    expect(f.delivered).toHaveLength(0);
    f.held.get(v.giftId!)!.state = 'refunded'; // the buyer took it back meanwhile
    clock.t += 60_000;
    await invites.tick();
    expect(invites.giftView('c1', ALICE)?.state).toBe('refunded');
  });
});

describe('invites over HTTP', () => {
  it('records the invite at sign-in and on accepting a challenge, attaches gifts for the challenger only', async () => {
    const f = { held: new Map<Hex, HeldGift>() };
    const gifts: GiftDeliverer = {
      async read(id) { return f.held.get(id) ?? { from: ALICE as Address, kind: 0, count: 0, state: 'none', refundableAt: 0 }; },
      async deliver() { return '0x' as Hex; },
    };
    const lobby = new Lobby({ chain: new Chain(null), house: privateKeyToAccount(generatePrivateKey()) });
    const quests = new Quests({ chainId: 31337 });
    const invites = new Invites({ chainId: 31337, quests, gifts, hasPlayed: (a) => lobby.hasPlayed(a) });
    const { server } = createApi(lobby, { ratePerSec: 10_000, quests, invites });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const player = async (ref?: Address) => { const c = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey())); await c.connect({ ref }); return c; };
    try {
      const alice = await player();
      const bob = await player(alice.address);
      expect((await bob.invites()).invitedBy).toMatchObject({ inviter: alice.address.toLowerCase(), via: 'link' });
      expect((await alice.invites()).invited.map((i) => i.invited)).toEqual([bob.address.toLowerCase()]);

      // Carol never played: accepting Alice's challenge makes Alice her inviter.
      const c = await alice.createChallenge({ race: 'agents' });
      const g = await alice.attachGift(c.code);
      expect(g.giftId).toMatch(/^0x[0-9a-f]{64}$/);
      const carol = await player();
      await expect(carol.attachGift(c.code)).rejects.toThrow(/→ 403/);
      f.held.set(g.giftId!, { from: alice.address, kind: 0, count: 1, state: 'held', refundableAt: 0 });
      await alice.attachGift(c.code); // confirm the payment
      expect((await carol.challenge(c.code)).gift).toMatchObject({ state: 'held', count: 1 });
      expect((await carol.challenge(c.code)).gift?.giftId).toBeUndefined();
      await carol.acceptChallenge(c.code, { race: 'degens' });
      expect((await carol.invites()).invitedBy).toMatchObject({ inviter: alice.address.toLowerCase(), via: 'challenge' });

      // Carol has a match now: signing in again through someone else's invite link changes nothing.
      const dave = await player();
      const carolAgain = new ForkfallClient(url, carol.account);
      await carolAgain.connect({ ref: dave.address });
      expect((await carolAgain.invites()).invitedBy?.inviter).toBe(alice.address.toLowerCase());
      expect((await dave.invites()).invited).toHaveLength(0);
      // A known player who was never invited stays uninvited.
      expect(invites.invite(alice.address, dave.address, 'link')).toBe(false); // Alice has played (the challenge)
    } finally { server.close(); }
  });
});
