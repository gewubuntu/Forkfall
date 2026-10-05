/**
 * Balance simulator: greedy bot vs greedy bot, every race pairing, with the starter decks and with random
 * ranked-legal decks from each race's whole pool.
 * Balance gate from the GDD: every race's overall win rate within 45–55%.
 *   pnpm sim [gamesPerPairing] [poncho]
 * Exits 1 when a gate is missed, so CI fails instead of printing a warning. Seeds are fixed: same code, same result.
 * Pairings run in parallel worker threads (one per CPU); every game has its own seed, so the result doesn't depend
 * on how the work is split.
 */
import { availableParallelism } from 'node:os';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { card, COLLECTIBLE, createMatch, greedyBot, keccakHex, playOut, RACES, randomRankedDeck, setOf, starterDeck, type Race } from '../src/index.ts';

type Gate = 'starter decks' | 'pool decks';
type Job = { kind: 'race'; gate: Gate; a: Race; b: Race; n: number } | { kind: 'poncho'; a: Race; b: Race; n: number };
interface RaceResult { aw: number; bw: number; draws: number; turns: number }
interface PonchoResult { w: number; n: number }

const ponchoDeck = (race: Race) => {
  const core = starterDeck(race).filter((id) => card(id).faction !== 'neutral');
  const poncho = COLLECTIBLE.filter((c) => setOf(c) === 'poncho').flatMap((c) => (c.rarity === 'legendary' ? [c.id] : [c.id, c.id]));
  return [...core, ...poncho, 33].slice(0, 30);
};

function runJob(job: Job): RaceResult | PonchoResult {
  const bot = greedyBot();
  const { a, b } = job;
  if (job.kind === 'race') {
    // Starter decks: what every new player plays. Pool decks: random ranked-legal decks from each race's whole core
    // pool, so every card in the set is played (a new card outside the starters shows up only here).
    const deckFor = (race: Race, i: number) => (job.gate === 'starter decks' ? starterDeck(race) : randomRankedDeck(race, `${a}-${b}-${i}`));
    const r: RaceResult = { aw: 0, bw: 0, draws: 0, turns: 0 };
    for (let i = 0; i < job.n; i++) {
      const { state } = createMatch({
        matchId: `sim-${i}`, seed: keccakHex(`sim-${a}-${b}-${i}`),
        players: [
          { address: '0x' + '1'.repeat(40), race: a, deck: deckFor(a, i), deckSalt: '0x01' },
          { address: '0x' + '2'.repeat(40), race: b, deck: deckFor(b, i), deckSalt: '0x02' },
        ],
      });
      const end = playOut(state, [bot, bot]);
      r.turns += end.turn;
      if (end.winner === 0) r.aw++; else if (end.winner === 1) r.bw++; else r.draws++;
    }
    return r;
  }
  // Poncho: race `a` with the Poncho set against race `b`'s plain starter deck, in both seats.
  const r: PonchoResult = { w: 0, n: 0 };
  for (let i = 0; i < job.n; i++) {
    for (const seatP of [0, 1] as const) {
      const decks = seatP === 0 ? [ponchoDeck(a), starterDeck(b)] : [starterDeck(b), ponchoDeck(a)];
      const races = seatP === 0 ? [a, b] : [b, a];
      const { state } = createMatch({
        matchId: `poncho-${i}`, seed: keccakHex(`poncho-${a}-${b}-${i}-${seatP}`),
        players: [
          { address: '0x' + '1'.repeat(40), race: races[0], deck: decks[0], deckSalt: '0x01' },
          { address: '0x' + '2'.repeat(40), race: races[1], deck: decks[1], deckSalt: '0x02' },
        ],
      });
      const end = playOut(state, [bot, bot]);
      r.n++; if (end.winner === seatP) r.w++;
    }
  }
  return r;
}

/** Run jobs on a pool of worker threads (this same file); results come back in job order. */
function runAll(jobs: Job[]): Promise<(RaceResult | PonchoResult)[]> {
  const results: (RaceResult | PonchoResult)[] = Array.from({ length: jobs.length });
  let next = 0, done = 0;
  return new Promise((resolve, reject) => {
    const threads = Math.max(1, Math.min(availableParallelism(), jobs.length));
    const workers: Worker[] = [];
    let failed = false;
    const fail = (e: Error) => { if (failed) return; failed = true; for (const w of workers) void w.terminate(); reject(e); };
    for (let t = 0; t < threads; t++) {
      const w = new Worker(new URL(import.meta.url), { execArgv: process.execArgv });
      workers.push(w);
      let current = -1;
      let retired = false; // terminated on purpose: no jobs left, or the run failed
      const feed = () => {
        if (next >= jobs.length) { retired = true; void w.terminate(); return; }
        current = next++;
        w.postMessage(jobs[current]);
      };
      w.on('message', (r: RaceResult | PonchoResult) => {
        results[current] = r;
        if (++done === jobs.length) resolve(results);
        feed();
      });
      w.on('error', fail);
      // A worker that dies without an error event (process.exit, out of memory) would leave the run waiting forever.
      w.on('exit', (code) => { if (!retired && code !== 0 && done < jobs.length) fail(new Error(`sim worker exited with code ${code} during job ${current}`)); });
      feed();
    }
  });
}

/** Prints the matrix and per-race win rates for one gate; returns whether every race is within 45–55%. */
function raceGate(title: Gate, pairs: [Race, Race][], res: RaceResult[], n: number): boolean {
  const wins: Record<Race, number> = { agents: 0, prophets: 0, brokers: 0, degens: 0 };
  const games: Record<Race, number> = { agents: 0, prophets: 0, brokers: 0, degens: 0 };
  const matrix: Record<string, string> = {};
  let turns = 0, total = 0, draws = 0;
  pairs.forEach(([a, b], k) => {
    const r = res[k];
    wins[a] += r.aw; wins[b] += r.bw; games[a] += n; games[b] += n;
    turns += r.turns; total += n; draws += r.draws;
    matrix[`${a} vs ${b}`] = `${((r.aw / n) * 100).toFixed(1)}% / ${((r.bw / n) * 100).toFixed(1)}%`;
  });
  console.log(`\nForkfall balance sim — ${title}: ${n} games per pairing, greedy bots\n`);
  console.table(matrix);
  console.table(Object.fromEntries(RACES.map((r) => [r, `${((wins[r] / games[r]) * 100).toFixed(1)}%`])));
  console.log(`avg half-turns: ${(turns / total).toFixed(1)} (≈${(turns / total / 2).toFixed(1)} turns each), draws: ${draws}`);
  const ok = RACES.every((r) => { const w = wins[r] / games[r]; return w >= 0.45 && w <= 0.55; });
  console.log(ok ? `✅ ${title}: balance gate passed (all races 45–55%)` : `❌ ${title}: balance gate not met (target 45–55%)`);
  return ok;
}

async function main() {
  const N = Number(process.argv[2] ?? 200);
  const poncho = process.argv[3] === 'poncho';
  const pairs: [Race, Race][] = [];
  for (const a of RACES) for (const b of RACES) if (a < b) pairs.push([a, b]);
  const gates: Gate[] = ['starter decks', 'pool decks'];
  const jobs: Job[] = gates.flatMap((gate) => pairs.map(([a, b]): Job => ({ kind: 'race', gate, a, b, n: N })));
  // Collab-set check: `pnpm sim 200 poncho` swaps each race's neutral slots for the Poncho set and plays it
  // against every plain starter deck. The set should be a fun alternative, not a must-play (target ≤ 58%).
  if (poncho) for (const a of RACES) for (const b of RACES) jobs.push({ kind: 'poncho', a, b, n: N / 2 });
  const res = await runAll(jobs);

  gates.forEach((gate, gi) => {
    const slice = res.slice(gi * pairs.length, (gi + 1) * pairs.length) as RaceResult[];
    if (!raceGate(gate, pairs, slice, N)) process.exitCode = 1;
  });
  if (!poncho) return;
  const out: Record<string, string> = {};
  let pw = 0, pg = 0;
  const pres = res.slice(gates.length * pairs.length) as PonchoResult[];
  RACES.forEach((a, ai) => {
    let w = 0, n = 0;
    for (let bi = 0; bi < RACES.length; bi++) { const r = pres[ai * RACES.length + bi]; w += r.w; n += r.n; }
    out[`${a} + Poncho`] = `${((w / n) * 100).toFixed(1)}%`;
    pw += w; pg += n;
  });
  console.log('\nPoncho set vs plain starter decks (same race pool, both seats):');
  console.table(out);
  const rate = pw / pg;
  console.log(`overall ${(rate * 100).toFixed(1)}% ${rate <= 0.58 ? '✅ fun, not must-play (≤ 58%)' : '❌ too strong (> 58%)'}`);
  if (rate > 0.58) process.exitCode = 1;
}

if (isMainThread) await main();
else parentPort!.on('message', (job: Job) => parentPort!.postMessage(runJob(job)));
