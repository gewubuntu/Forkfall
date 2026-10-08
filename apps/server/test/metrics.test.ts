import { dayStartMs, questDay } from '@forkfall/engine';
import type { MetricsReport } from '@forkfall/sdk';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Chain, metricsChain } from '../src/chain.ts';
import { createApi } from '../src/http.ts';
import { Lobby } from '../src/lobby.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GATE_DAYS, Metrics, MIN_COHORT, type ChainEvent, type MetricsChain } from '../src/metrics.ts';
import type { FinishedMatch } from '../src/quests.ts';

const NOON = Date.UTC(2026, 9, 21, 12);
const TODAY = questDay(NOON);
const at = (day: number) => dayStartMs(day) + 3_600_000;
const wallet = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;

let n = 0;
function match(a: string, b: string | null, day: number, o: { botB?: boolean; sealed?: boolean; agentA?: boolean } = {}): FinishedMatch {
  return {
    id: `m${++n}`, endedAt: at(day), turns: 9, winner: 0, events: [],
    players: [{ address: a, race: 'agents', bot: null }, { address: b ?? '0xfe', race: 'degens', bot: o.botB ? 'greedy' : null }],
    agents: [!!o.agentA, false],
    ...(o.sealed ? { format: 'sealed' as const } : {}),
  };
}

function fakeChain(events: (ChainEvent & { block: number })[], head: number, startBlock = 100) {
  const asked: [number, number][] = [];
  const chain: MetricsChain = {
    startBlock,
    head: async () => head,
    events: async (from, to) => { asked.push([from, to]); return events.filter((e) => e.block >= from && e.block <= to); },
  };
  return { chain, asked };
}

describe('what counts as activity', () => {
  it('counts matches between people, Sealed matches against the house bot, never Practice or bot-only matches', () => {
    const m = new Metrics({ now: () => NOON });
    m.record(match(wallet(1), wallet(2), TODAY));
    m.record(match(wallet(3), null, TODAY, { botB: true })); // Practice
    m.record(match(wallet(4), null, TODAY, { botB: true, sealed: true })); // Sealed vs the house bot
    const d = m.report(1).humans.daily[0];
    expect(d.active).toBe(3); // 1, 2 and 4: wallet 3 only practised
    expect(d.matches).toBe(3);
  });

  it('counts a match once however often it is reported', () => {
    const m = new Metrics({ now: () => NOON });
    const x = match(wallet(1), wallet(2), TODAY);
    m.record(x); m.record(x); m.record({ ...x });
    expect(m.report(1).humans.daily[0].matches).toBe(2); // two human seats, one match
  });

  it('keeps agents on their own row', () => {
    const m = new Metrics({ now: () => NOON });
    m.record(match(wallet(1), wallet(2), TODAY, { agentA: true }));
    const r = m.report(1);
    expect(r.agents.daily[0]).toMatchObject({ active: 1, matches: 1 });
    expect(r.humans.daily[0]).toMatchObject({ active: 1, matches: 1 });
  });
});

describe('retention', () => {
  /** 10 wallets first active on D; 4 return on D+1, 1 more on D+3, 1 on D+7. */
  function cohort(m: Metrics, D: number) {
    for (let i = 1; i <= 10; i++) m.record(match(wallet(i), wallet(100 + i), D));
    for (let i = 1; i <= 4; i++) m.record(match(wallet(i), wallet(100 + i), D + 1));
    m.record(match(wallet(5), wallet(105), D + 3));
    m.record(match(wallet(6), wallet(106), D + 7));
  }

  it('measures day-1, day-7 and within-a-week by cohort day', () => {
    const m = new Metrics({ now: () => NOON });
    const D = TODAY - 10;
    cohort(m, D);
    const c = m.report(30).humans.cohorts.find((x) => x.day === D)!;
    // wallet(1..10) and their opponents wallet(101..110): 20 wallets first active on D
    expect(c.size).toBe(20);
    expect(c.d1).toBe(4 * 2 / 20); // wallets 1-4 and their opponents 101-104 played D+1
    expect(c.d7).toBe(2 / 20); // 6 and 106
    expect(c.week).toBe((4 * 2 + 2 + 2) / 20); // D+1 players, plus 5/105 on D+3, plus 6/106 on D+7
  });

  it('shows no rate for a cohort under the minimum, or for a day not yet finished', () => {
    const m = new Metrics({ now: () => NOON });
    for (let i = 1; i < MIN_COHORT; i++) m.record(match(wallet(i), null, TODAY - 5, { botB: true, sealed: true }));
    for (let i = 1; i < MIN_COHORT; i++) m.record(match(wallet(i), null, TODAY - 4, { botB: true, sealed: true }));
    const small = m.report(30).humans.cohorts.find((x) => x.day === TODAY - 5)!;
    expect(small.size).toBe(MIN_COHORT - 1);
    expect(small.d1).toBeNull();
    // A big cohort whose D+1 is today: today isn't over, so no day-1 rate yet.
    for (let i = 1; i <= 8; i++) m.record(match(wallet(50 + i), null, TODAY - 1, { botB: true, sealed: true }));
    const fresh = m.report(30).humans.cohorts.find((x) => x.day === TODAY - 1)!;
    expect(fresh.size).toBe(8);
    expect(fresh.d1).toBeNull();
  });
});

describe('the gate', () => {
  it('weights across cohorts, humans only, and passes only when every number is known and met', () => {
    const m = new Metrics({ now: () => NOON, chain: fakeChain([], 0).chain });
    const D = TODAY - 9;
    // 10 humans (unique, bot-free pairs below): all play 5 matches on D and D+1.
    for (let i = 1; i <= 10; i++) {
      for (let k = 0; k < 5; k++) { m.record(match(wallet(i), null, D, { botB: true, sealed: true })); m.record(match(wallet(i), null, D + 1, { botB: true, sealed: true })); }
    }
    const g = m.report(30).gate;
    expect(g.days).toBe(GATE_DAYS);
    const row = (id: string) => g.rows.find((r) => r.id === id)!;
    expect(row('d1')).toMatchObject({ value: 1, met: true });
    expect(row('d7')).toMatchObject({ value: 0, met: false });
    expect(row('matches').value).toBe(5); // 100 matches / 20 player-days
    expect(row('packs').value).toBe(0);
    expect(g.passed).toBe(false);
  });

  it('is unknown (null), not failed, with too few players', () => {
    const m = new Metrics({ now: () => NOON });
    m.record(match(wallet(1), wallet(2), TODAY - 3));
    expect(m.report(30).gate.passed).toBeNull();
    expect(m.report(30).gate.rows.every((r) => r.value === null)).toBe(true);
  });
});

describe('chain logs', () => {
  it('counts packs and crafts per day from the deployment block, and crafting share by day 7', async () => {
    const D = TODAY - 10;
    const players = Array.from({ length: 6 }, (_, i) => wallet(i + 1));
    const events = [
      { kind: 'pack' as const, owner: players[0], at: at(D), block: 101 },
      { kind: 'pack' as const, owner: players[1], at: at(D), block: 102 },
      { kind: 'craft' as const, owner: players[0], at: at(D + 2), block: 150 },
      { kind: 'craft' as const, owner: players[1], at: at(D + 9), block: 160 }, // after day 7
    ];
    const { chain, asked } = fakeChain(events, 3000);
    const m = new Metrics({ now: () => NOON, chain, since: TODAY - 30 });
    for (const p of players) m.record(match(p, null, D, { botB: true, sealed: true }));
    await m.poll();
    expect(asked[0][0]).toBe(100); // the deployment block
    const r = m.report(30);
    const day = r.humans.daily.find((x) => x.day === D)!;
    expect(day).toMatchObject({ active: 6, packs: 2, packsPerActive: 2 / 6 });
    expect(r.humans.cohorts.find((x) => x.day === D)!.craftedByD7).toBe(1 / 6); // wallet 1 only
    expect(r.humans.craftShare).toMatchObject({ crafted: 2, players: 6 });
  });

  it('resumes from its cursor after a restart and never counts a block twice', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'metrics-')), 'm.json');
    const events = [{ kind: 'pack' as const, owner: wallet(1), at: at(TODAY), block: 105 }];
    const a = fakeChain(events, 5000);
    const one = new Metrics({ file, now: () => NOON, chain: a.chain, since: TODAY - 30 });
    await one.poll(); // 5 chunks of 2000 blocks: 100 to 10099 clipped at the head
    const b = fakeChain(events, 5000);
    const two = new Metrics({ file, now: () => NOON, chain: b.chain, since: TODAY - 30 });
    await two.poll();
    expect(b.asked).toEqual([]); // nothing left to read
    expect(two.report(1).humans.daily[0].packs).toBe(1);
  });

  it('reads in ranges a free RPC tier accepts when METRICS_LOG_BLOCKS is set, and still keeps up', async () => {
    // Alchemy's free tier rejects eth_getLogs over more than 10 blocks.
    const events = [{ kind: 'pack' as const, owner: wallet(1), at: at(TODAY), block: 250 }];
    const { chain: inner, asked } = fakeChain(events, 400);
    const chain: MetricsChain = {
      ...inner,
      events: async (from, to) => {
        if (to - from + 1 > 10) throw new Error('Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range');
        return inner.events(from, to);
      },
    };
    const m = new Metrics({ now: () => NOON, chain, since: TODAY - 30, logBlocks: 10 });
    await m.poll();
    expect(asked.every(([from, to]) => to - from + 1 <= 10)).toBe(true);
    expect(asked[0]).toEqual([100, 109]);
    expect(asked.at(-1)![1]).toBe(299); // 200 blocks a poll: Base makes about 15 in 30 s
    expect(m.report(1).humans.daily[0].packs).toBe(1);
  });

  it('reads packs and crafts as null, not zero, without a chain', () => {
    const m = new Metrics({ now: () => NOON });
    const d = m.report(1).humans.daily[0];
    expect(d.packs).toBeNull();
    expect(d.crafts).toBeNull();
    expect(m.report(1).onchain).toBe(false);
  });
});

describe('privacy and storage', () => {
  it('reports and exports aggregates only, never a wallet', () => {
    const m = new Metrics({ now: () => NOON });
    m.record(match(wallet(0xabc), wallet(0xdef), TODAY));
    const text = JSON.stringify(m.report(30)) + m.csv(30);
    expect(text).not.toMatch(/0x0000000000000000000000000000000000000abc/i);
    expect(text).not.toMatch(/abc|def/i);
    expect(m.csv(2).split('\n')[0]).toBe('date,group,active,new_players,matches,matches_per_active,packs,packs_per_active,crafts');
  });

  it('keeps its records across a restart', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'metrics-')), 'm.json');
    const one = new Metrics({ file, now: () => NOON });
    one.record(match(wallet(1), wallet(2), TODAY - 1));
    one.record(match(wallet(1), wallet(2), TODAY));
    const two = new Metrics({ file, now: () => NOON });
    expect(two.report(2).humans.daily.map((d) => d.active)).toEqual([2, 2]);
    two.record(match(wallet(1), wallet(2), TODAY)); // a new match id, still counted
    expect(two.report(1).humans.daily[0].matches).toBe(4);
  });

  it('copes with a wallet first seen late being active earlier (a back-fill)', () => {
    const m = new Metrics({ now: () => NOON });
    m.record(match(wallet(1), wallet(2), TODAY));
    m.record(match(wallet(1), wallet(2), TODAY - 3));
    const r = m.report(5).humans;
    expect(r.daily.filter((d) => d.active > 0).map((d) => d.day)).toEqual([TODAY - 3, TODAY]);
    expect(r.cohorts.find((c) => c.day === TODAY - 3)!.size).toBe(2);
  });
});

describe('GET /v1/metrics', () => {
  it('serves aggregates without signing in, and the same days as CSV', async () => {
    const m = new Metrics({ now: () => NOON });
    m.record(match(wallet(1), wallet(2), TODAY));
    const lobby = new Lobby({ chain: new Chain(null), house: privateKeyToAccount(generatePrivateKey()), now: () => NOON });
    const { server } = createApi(lobby, { metrics: m });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const json = await (await fetch(`${url}/v1/metrics?days=3`)).json() as MetricsReport;
      expect(json.humans.daily).toHaveLength(3);
      expect(json.humans.daily[2]).toMatchObject({ active: 2, matches: 2 });
      expect(json.onchain).toBe(false);
      const csv = await fetch(`${url}/v1/metrics?days=3&format=csv`);
      expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
      expect((await csv.text()).split('\n')).toHaveLength(8); // header, 3 days × 2 groups, trailing newline
      expect((await fetch(`${url}/v1/metrics?days=100000`)).status).toBe(200); // clamped, not an error
    } finally { server.close(); }
  });
});

describe('metricsChain (the viem adapter)', () => {
  it('turns PackOpened and Crafted logs into dated events, one block read per block', async () => {
    const calls: { address: string; fromBlock: bigint; toBlock: bigint }[] = [];
    let blockReads = 0;
    const client = {
      getBlockNumber: async () => 500n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => { blockReads++; return { timestamp: BigInt(1_000 + Number(blockNumber)) }; },
      getLogs: async (q: { address: string; fromBlock: bigint; toBlock: bigint }) => {
        calls.push(q);
        return q.address === '0xpack'
          ? [{ blockNumber: 7n, args: { owner: '0xa' } }, { blockNumber: 7n, args: { owner: '0xb' } }]
          : [{ blockNumber: 7n, args: { player: '0xa' } }];
      },
    };
    const chain = Object.assign(new Chain(null), { client, book: { chainId: 31337, PackSale: '0xpack', Crafting: '0xcraft', deployedAtBlock: 42 } });
    const mc = metricsChain(chain as unknown as Chain)!;
    expect(mc.startBlock).toBe(42);
    expect(metricsChain(Object.assign(new Chain(null), { client, book: { chainId: 31337, PackSale: '0xpack', Crafting: '0xcraft' } }) as unknown as Chain)!.startBlock).toBeUndefined();
    expect(await mc.head()).toBe(500);
    const ev = await mc.events(1, 10);
    expect(ev).toEqual([
      { kind: 'pack', owner: '0xa', at: 1_007_000 }, { kind: 'pack', owner: '0xb', at: 1_007_000 }, { kind: 'craft', owner: '0xa', at: 1_007_000 },
    ]);
    expect(blockReads).toBe(1);
    expect(calls.map((c) => c.address).sort()).toEqual(['0xcraft', '0xpack']);
    expect(metricsChain(new Chain(null))).toBeNull(); // off-chain
  });
});


describe('review fixes', () => {
  it('serves every window from one report computed at most every 30 s', () => {
    const clock = { t: NOON };
    const m = new Metrics({ now: () => clock.t });
    m.record(match(wallet(1), wallet(2), TODAY));
    const a = m.cachedReport(7);
    const b = m.cachedReport(90);
    expect(a.generatedAt).toBe(b.generatedAt); // the same computation
    expect(a.humans.daily).toHaveLength(7);
    expect(b.humans.daily).toHaveLength(90);
    expect(a.humans.daily[6]).toEqual(b.humans.daily[89]);
    clock.t += 31_000;
    expect(m.cachedReport(7).generatedAt).toBe(clock.t);
  });

  it('is "not yet" as soon as one measured number is below its target', () => {
    const m = new Metrics({ now: () => NOON });
    const D = TODAY - 9;
    for (let i = 1; i <= 10; i++) m.record(match(wallet(i), null, D, { botB: true, sealed: true })); // nobody returns
    const g = m.report(30).gate;
    expect(g.rows.find((r) => r.id === 'd1')).toMatchObject({ value: 0, met: false });
    expect(g.rows.some((r) => r.met === null)).toBe(true); // packs and crafts can't be measured without a chain
    expect(g.passed).toBe(false);
  });

  it('ignores a late re-notification of a match older than its dedupe window', () => {
    const m = new Metrics({ now: () => NOON });
    const first = match(wallet(1), wallet(2), TODAY - 1);
    m.record(first);
    for (let i = 0; i < 5001; i++) m.record(match(wallet(1), wallet(2), TODAY - 1));
    const before = m.report(2).humans.daily[0].matches;
    m.record(first); // fires again long after it fell out of the ring
    expect(m.report(2).humans.daily[0].matches).toBe(before);
  });

  it('skips chain events from before the store started counting', async () => {
    const events = [{ kind: 'pack' as const, owner: wallet(1), at: at(TODAY - 20), block: 105 }, { kind: 'pack' as const, owner: wallet(1), at: at(TODAY), block: 106 }];
    const m = new Metrics({ now: () => NOON, chain: fakeChain(events, 5000).chain, since: TODAY - 3 });
    await m.poll();
    const days = m.report(30).humans.daily;
    expect(days.reduce((s, d) => s + (d.packs ?? 0), 0)).toBe(1);
  });

  it('reads only confirmed blocks, and recovers when the chain was reset', async () => {
    const f = fakeChain([], 1000);
    const m = new Metrics({ now: () => NOON, chain: f.chain, since: TODAY - 3 });
    await m.poll();
    expect(f.asked.at(-1)![1]).toBe(995); // head 1000 minus 5 confirmations
    // A local chain restarted: the head is far behind the saved cursor.
    const g = fakeChain([{ kind: 'pack' as const, owner: wallet(1), at: at(TODAY), block: 12 }], 20);
    (m as unknown as { opts: { chain: MetricsChain } }).opts.chain = g.chain;
    await m.poll();
    await m.poll();
    expect(g.asked).toEqual([]); // reset to the new head, nothing behind it to read
  });

  it('counts from now when the address book has no deployment block', async () => {
    const asked: [number, number][] = [];
    const chain: MetricsChain = { head: async () => 9000, events: async (f, t) => { asked.push([f, t]); return []; } };
    const m = new Metrics({ now: () => NOON, chain });
    await m.poll();
    expect(asked).toEqual([]); // not a scan from genesis
  });
});


describe('finecomb fixes', () => {
  it('answers the CSV route with a JSON 500, not a hung connection, when the report fails', async () => {
    const broken = { csv: () => { throw new Error('boom'); } } as unknown as Metrics;
    const lobby = new Lobby({ chain: new Chain(null), house: privateKeyToAccount(generatePrivateKey()), now: () => NOON });
    const { server } = createApi(lobby, { metrics: broken });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const r = await fetch(`${url}/v1/metrics?format=csv`, { signal: AbortSignal.timeout(2000) });
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: 'boom' });
    } finally { server.close(); }
  });

  it('sets aside a store whose wallet records are malformed instead of throwing on every report', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'metrics-')), 'm.json');
    writeFileSync(file, JSON.stringify({ wallets: { '0xaa': { first: 20000, bits: 'zz' } }, crafters: {}, days: {}, seen: [] }));
    const m = new Metrics({ file, now: () => NOON });
    expect(m.setAside).not.toBeNull();
    expect(() => m.csv(30)).not.toThrow();
  });

  it('needs five distinct players, not five player-days, for the per-player gate numbers', () => {
    const one = new Metrics({ now: () => NOON });
    for (let k = 1; k <= 5; k++) one.record(match(wallet(1), null, TODAY - k, { botB: true, sealed: true }));
    expect(one.report(30).gate.rows.find((r) => r.id === 'matches')!.value).toBeNull();
    const five = new Metrics({ now: () => NOON });
    for (let i = 1; i <= 5; i++) five.record(match(wallet(i), null, TODAY - 1, { botB: true, sealed: true }));
    expect(five.report(30).gate.rows.find((r) => r.id === 'matches')!.value).toBe(1);
  });
});
