/**
 * Balance simulator: greedy bot vs greedy bot with starter decks, every race pairing.
 * Balance gate from the GDD: every race's overall win rate within 45–55%.
 *   pnpm sim [gamesPerPairing]
 */
import { createMatch, greedyBot, keccakHex, playOut, RACES, starterDeck, type Race } from '../src/index.ts';

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
