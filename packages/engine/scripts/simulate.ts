/**
 * Balance simulator: greedy bot vs greedy bot with starter decks, every race pairing.
 * Balance gate from the GDD: every race's overall win rate within 45–55%.
 *   pnpm sim [gamesPerPairing]
 */
import { card, COLLECTIBLE, createMatch, greedyBot, keccakHex, playOut, RACES, setOf, starterDeck, type Race } from '../src/index.ts';

const N = Number(process.argv[2] ?? 200);
const bot = greedyBot();
const wins: Record<Race, number> = { agents: 0, prophets: 0, brokers: 0, degens: 0 };
const games: Record<Race, number> = { agents: 0, prophets: 0, brokers: 0, degens: 0 };
const matrix: Record<string, string> = {};
let turns = 0, total = 0, draws = 0;

for (const a of RACES) for (const b of RACES) {
  if (a >= b) continue;
  let aw = 0, bw = 0;
  for (let i = 0; i < N; i++) {
    const seed = keccakHex(`sim-${a}-${b}-${i}`);
    const { state } = createMatch({
      matchId: `sim-${i}`, seed,
      players: [
        { address: '0x' + '1'.repeat(40), race: a, deck: starterDeck(a), deckSalt: '0x01' },
        { address: '0x' + '2'.repeat(40), race: b, deck: starterDeck(b), deckSalt: '0x02' },
      ],
    });
    const end = playOut(state, [bot, bot]);
    turns += end.turn; total++;
    if (end.winner === 0) aw++; else if (end.winner === 1) bw++; else draws++;
  }
  wins[a] += aw; wins[b] += bw; games[a] += N; games[b] += N;
  matrix[`${a} vs ${b}`] = `${((aw / N) * 100).toFixed(1)}% / ${((bw / N) * 100).toFixed(1)}%`;
}

console.log(`\nForkfall balance sim — ${N} games per pairing, greedy bots, starter decks\n`);
console.table(matrix);
const summary = Object.fromEntries(RACES.map((r) => [r, `${((wins[r] / games[r]) * 100).toFixed(1)}%`]));
console.table(summary);
console.log(`avg half-turns: ${(turns / total).toFixed(1)} (≈${(turns / total / 2).toFixed(1)} turns each), draws: ${draws}`);
const ok = RACES.every((r) => { const w = wins[r] / games[r]; return w >= 0.45 && w <= 0.55; });
console.log(ok ? '✅ balance gate passed (all races 45–55%)' : '⚠️  balance gate not met (target 45–55%)');

// Collab-set check: `pnpm sim 200 poncho` swaps each race's neutral slots for the Poncho set and plays it
// against every plain starter deck. The set should be a fun alternative, not a must-play (target ≤ 58%).
if (process.argv[3] === 'poncho') {
  const ponchoDeck = (race: Race) => {
    const core = starterDeck(race).filter((id) => card(id).faction !== 'neutral');
    const poncho = COLLECTIBLE.filter((c) => setOf(c) === 'poncho').flatMap((c) => (c.rarity === 'legendary' ? [c.id] : [c.id, c.id]));
    return [...core, ...poncho, 33].slice(0, 30);
  };
  const res: Record<string, string> = {};
  let pw = 0, pg = 0;
  for (const a of RACES) {
    let w = 0, n = 0;
    for (const b of RACES) for (let i = 0; i < N / 2; i++) {
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
        n++; if (end.winner === seatP) w++;
      }
    }
    res[`${a} + Poncho`] = `${((w / n) * 100).toFixed(1)}%`;
    pw += w; pg += n;
  }
  console.log('\nPoncho set vs plain starter decks (same race pool, both seats):');
  console.table(res);
  const rate = pw / pg;
  console.log(`overall ${(rate * 100).toFixed(1)}% ${rate <= 0.58 ? '✅ fun, not must-play (≤ 58%)' : '⚠️  too strong (> 58%)'}`);
}
