import { commitSeed, eloUpdate, START_RATING, ZERO_ADDRESS } from '@forkfall/sdk';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { Chain, type LeagueOps } from '../src/chain.ts';
import { Lobby, RATING_WINDOW, ratingWindow } from '../src/lobby.ts';

/** Off-chain Chain that reports scripted season ratings (null = no chain: the lobby estimates them itself). */
class RatedChain extends Chain {
  ratings = new Map<string, number>();
  reads = 0;
  constructor(readonly online_ = true) { super(null); }
  override async rating(_season: number, a: Address) {
    this.reads++;
    return this.online_ ? (this.ratings.get(a.toLowerCase()) ?? START_RATING) : null;
  }
}

const addr = () => privateKeyToAccount(generatePrivateKey()).address;
const commit = commitSeed(('0x' + '11'.repeat(32)) as Hex) as Hex;

function setup(opts: { chain?: Chain; league?: LeagueOps } = {}) {
  const clock = { t: 1_000_000 };
  const chain = opts.chain ?? new RatedChain();
  const lobby = new Lobby({ chain, house: privateKeyToAccount(generatePrivateKey()), now: () => clock.t, queueTtlSeconds: 3600, league: opts.league });
  const join = (a: Address, mode: 'ranked' | 'human' | 'casual' | 'league' = 'ranked') =>
    lobby.enqueue(a, { mode, race: 'agents', seedCommit: commit }, mode === 'league');
  const after = (ms: number) => { clock.t += ms; };
  return { lobby, chain, join, after, clock };
}

function rated(ratings: Record<string, number>) {
  const chain = new RatedChain();
  for (const [a, r] of Object.entries(ratings)) chain.ratings.set(a.toLowerCase(), r);
  return chain;
}

describe('rating window', () => {
  it('starts at ±100, widens 50 every 10 s, and takes anyone after a minute', () => {
    expect(ratingWindow(0)).toBe(100);
    expect(ratingWindow(9_999)).toBe(100);
    expect(ratingWindow(10_000)).toBe(150);
    expect(ratingWindow(59_999)).toBe(350);
    expect(ratingWindow(RATING_WINDOW.anyoneAfterMs)).toBe(Infinity);
  });
});

describe('rated queues pair by rating', () => {
  it('keeps far-apart players waiting until their windows meet, then the tick pairs them', async () => {
    const [a, b] = [addr(), addr()];
    const { lobby, join, after } = setup({ chain: rated({ [a]: 1200, [b]: 1500 }) });
    expect(await join(a)).toMatchObject({ status: 'queued' });
    expect(await join(b)).toMatchObject({ status: 'queued' }); // 300 apart, window 100
    after(30_000); await lobby.matchQueue();
    expect(lobby.queueStatus(a).status).toBe('queued'); // window 250
    after(10_000); await lobby.matchQueue();
    const s = lobby.queueStatus(a);
    expect(s).toMatchObject({ status: 'matched' }); // window 300
    expect(lobby.queueStatus(b)).toMatchObject({ status: 'matched', matchId: (s as { matchId: Hex }).matchId });
  });

  it('pairs an arrival with the closest rating, not the longest waiter', async () => {
    const [older, closer, me] = [addr(), addr(), addr()];
    // 150 apart, so they don't pair with each other; both are within ±100 of the arrival.
    const { lobby, join, after } = setup({ chain: rated({ [older]: 1270, [closer]: 1420, [me]: 1350 }) });
    await join(older);
    after(5_000);
    await join(closer);
    expect([older, closer].map((p) => lobby.queueStatus(p).status)).toEqual(['queued', 'queued']);
    const r = await join(me) as { status: string; matchId: Hex };
    expect(r.status).toBe('matched');
    expect(lobby.matches.get(r.matchId)!.players.map((p) => p.address)).toEqual([closer, me]);
    expect(lobby.queueStatus(older).status).toBe('queued');
  });

  it('pairs anyone after a minute, the longest waiter first', async () => {
    const [low, high] = [addr(), addr()];
    const { lobby, join, after } = setup({ chain: rated({ [low]: 600, [high]: 2400 }) });
    await join(low); await join(high);
    after(59_000); await lobby.matchQueue();
    expect(lobby.queueStatus(low).status).toBe('queued');
    after(1_000); await lobby.matchQueue();
    expect(lobby.queueStatus(low).status).toBe('matched');
    const id = (lobby.queueStatus(low) as { matchId: Hex }).matchId;
    expect(lobby.matches.get(id)!.players.map((p) => p.address)).toEqual([low, high]); // waiter takes seat 0, as before
  });

  it('the one-second tick runs the sweep, and a waiting queue reads no season until someone can pair', async () => {
    const [a, b] = [addr(), addr()];
    const chain = rated({ [a]: 1000, [b]: 1500 });
    let seasonReads = 0;
    chain.season = async () => { seasonReads++; return 1; };
    const { lobby, join, after } = setup({ chain });
    await join(a); await join(b);
    const before = seasonReads;
    for (let i = 0; i < 5; i++) { after(1_000); lobby.tick(); await Promise.resolve(); }
    expect(seasonReads).toBe(before);
    after(60_000); lobby.tick(); await new Promise((r) => setTimeout(r, 10));
    expect(lobby.queueStatus(a).status).toBe('matched');
  });

  it('the Human queue is rated the same way; casual still pairs whoever is waiting', async () => {
    const [a, b, c, d] = [addr(), addr(), addr(), addr()];
    const { lobby, join } = setup({ chain: rated({ [a]: 1000, [b]: 1800, [c]: 1000, [d]: 1800 }) });
    await join(a, 'human');
    expect(await join(b, 'human')).toMatchObject({ status: 'queued' });
    await join(c, 'casual');
    expect(await join(d, 'casual')).toMatchObject({ status: 'matched' });
    expect(lobby.queueStatus(a).status).toBe('queued');
  });

  it('a chain read that fails falls back to the referee’s own estimate instead of refusing the queue', async () => {
    const chain = new RatedChain();
    chain.rating = async () => { throw new Error('rpc down'); };
    const { join } = setup({ chain });
    expect(await join(addr())).toMatchObject({ status: 'queued' });
  });
});

describe('off-chain rating estimate', () => {
  it('replays the season’s Elo over refereed ranked and Human queue matches, in the order they ended', async () => {
    const [a, b, c] = [addr(), addr(), addr()];
    const { lobby } = setup({ chain: new RatedChain(false) });
    const ended = (id: string, mode: string, season: number, endedAt: number, x: Address, y: Address, winner: Address) =>
      lobby.matches.set(id as Hex, { id, mode, season, endedAt, phase: 'ended', players: [{ address: x }, { address: y }], result: { winner } } as never);
    ended('0x02', 'human', 1, 20, a, c, c);
    ended('0x01', 'ranked', 1, 10, a, b, a);
    ended('0x03', 'ranked', 1, 30, b, c, ZERO_ADDRESS);
    ended('0x04', 'casual', 0, 40, a, b, a); // casual is unrated
    ended('0x05', 'ranked', 2, 50, a, b, a); // another season
    ended('0x06', 'league', 1, 60, a, b, a); // the league has its own ratings

    let [ra, rb, rc] = [START_RATING, START_RATING, START_RATING];
    [ra, rb] = eloUpdate(ra, rb, 1000);
    [ra, rc] = eloUpdate(ra, rc, 0);
    [rb, rc] = eloUpdate(rb, rc, 500);
    expect([a, b, c].map((p) => lobby.localRating(1, p))).toEqual([ra, rb, rc]);
    expect(lobby.localRating(1, a.toLowerCase() as Address)).toBe(ra);
    expect(lobby.localRating(1, addr())).toBe(START_RATING);
  });

  it('is what the queue uses without a chain', async () => {
    const [winner, loser, fresh] = [addr(), addr(), addr()];
    const { lobby, join } = setup({ chain: new RatedChain(false) });
    // 10 straight wins: about 1340, far from a newcomer's 1200.
    for (let i = 0; i < 10; i++) {
      lobby.matches.set(`0x${i + 1}` as Hex, { id: `0x${i + 1}`, mode: 'ranked', season: 1, endedAt: i, phase: 'ended', players: [{ address: winner }, { address: loser }], result: { winner } } as never);
    }
    expect(lobby.localRating(1, winner)).toBeGreaterThan(START_RATING + 100);
    await join(winner);
    expect(await join(fresh)).toMatchObject({ status: 'queued' });
  });
});

describe('Agent League pairing', () => {
  const league = (ratings: Record<string, number>, operators: Record<string, Address>): LeagueOps => ({
    entryFee: async () => 500_000n, currentWeek: async () => 7, balanceOf: async () => 5_000_000n,
    operatorOf: async (a: Address) => operators[a] ?? a,
    rating: async (week: number, a: Address) => { expect(week).toBe(7); return ratings[a] ?? START_RATING; },
    start: async () => ('0x' + 'ee'.repeat(32)) as Hex, started: async () => false,
    cancel: async () => ('0x' + '00'.repeat(32)) as Hex, info: async () => ({ enabled: true }) as never,
  });

  it('uses the week’s league standing, and never pairs one operator’s agents, even after a minute', async () => {
    const [a, b, c] = [addr(), addr(), addr()];
    const op = addr();
    const { lobby, join, after } = setup({ league: league({ [a]: 1200, [b]: 1210, [c]: 1700 }, { [a]: op, [b]: op }) });
    await join(a, 'league');
    expect(await join(b, 'league')).toMatchObject({ status: 'queued' }); // same operator
    await join(c, 'league'); // 490 above both
    expect(lobby.queueStatus(c).status).toBe('queued');
    after(RATING_WINDOW.anyoneAfterMs); await lobby.matchQueue();
    const s = lobby.queueStatus(a) as { status: string; matchId: Hex };
    expect(s.status).toBe('matched');
    expect(lobby.matches.get(s.matchId)!.players.map((p) => p.address)).toEqual([a, c]);
    expect(lobby.matches.get(s.matchId)!.season).toBe(7);
    expect(lobby.queueStatus(b).status).toBe('queued');
  });
});
