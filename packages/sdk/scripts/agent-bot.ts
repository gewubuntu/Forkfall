/**
 * Reference Forkfall agent: queues, plays with the view-only greedy policy, co-signs results.
 *
 *   PRIVATE_KEY=0x... SERVER_URL=http://localhost:8787 MODE=ranked RACE=agents DECK_ID=0x... GAMES=1 pnpm bot
 *   PRACTICE=1 RACE=degens pnpm bot           # vs the house bot
 */
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import type { Hex } from 'viem';
import type { Race } from '@forkfall/engine';
import { ForkfallClient, runMatch, type Mode } from '../src/index.ts';

const env = process.env;
const account = privateKeyToAccount((env.PRIVATE_KEY as Hex) ?? generatePrivateKey());
const client = new ForkfallClient(env.SERVER_URL ?? 'http://localhost:8787', account);
const race = (env.RACE ?? 'agents') as Race;
const mode = (env.MODE ?? 'casual') as Mode;
const games = Number(env.GAMES ?? 1);
const log = (m: string) => env.VERBOSE && console.log(`[${account.address.slice(0, 8)}] ${m}`);

await client.connect({ agent: true });
console.log(`agent ${account.address} connected (${race}, ${env.PRACTICE ? 'practice' : mode})`);

for (let i = 0; i < games; i++) {
  let matchId: Hex;
  if (env.PRACTICE) {
    matchId = await client.practice({ race });
  } else {
    let q = await client.queue({ mode, race, deckId: env.DECK_ID as Hex | undefined });
    while (q.status !== 'matched') {
      await new Promise((r) => setTimeout(r, 500));
      q = await client.queueStatus();
    }
    matchId = q.matchId!;
  }
  console.log(`match ${matchId}`);
  const end = await runMatch(client, matchId, { log });
  const me = end.seat!;
  const w = end.view!.winner;
  console.log(`  ended after ${end.view!.turn} half-turns: ${w === 'draw' ? 'draw' : w === me ? 'WIN' : 'loss'} (${end.view!.endReason})`);
  if (env.WRITE_SETTLEMENT !== '0') {
    const s = await client.settlement(matchId).catch((e) => ({ error: String(e) }));
    console.log('  settlement:', 'error' in s ? s.error : `ready (byReferee=${(s as any).byReferee})`);
  }
}
