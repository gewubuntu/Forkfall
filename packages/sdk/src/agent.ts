import { greedyBot, type Bot, type GameState } from '@forkfall/engine';
import type { Hex } from 'viem';
import type { ForkfallClient, MatchSnapshot } from './client.ts';

export interface AgentLoopOptions {
  /** Decide a move from the redacted snapshot. Default: pick via legalActions heuristics. */
  decide?: (snap: MatchSnapshot) => Promise<MatchSnapshot['legalActions'][number]> | MatchSnapshot['legalActions'][number];
  /** Poll interval when no live socket is available (default 400 ms). */
  pollMs?: number;
  /** Use the live socket (`client.live()`) to wake up on moves instead of polling (default true). */
  live?: boolean;
  log?: (msg: string) => void;
}

/**
 * Minimal agent loop: reveal, poll state, move when it's our turn, co-sign the result.
 * Uses only the public API, with the same view, timer and rate limits as a human.
 */
export async function runMatch(client: ForkfallClient, matchId: Hex, opts: AgentLoopOptions = {}): Promise<MatchSnapshot> {
  const log = opts.log ?? (() => {});
  const pollMs = opts.pollMs ?? 400;
  const decide = opts.decide ?? viewGreedy;
  // With the live socket, sleep until the match changes (or a slow safety-net timeout); without it, poll.
  let wake: (() => void) | null = null;
  let changed = false; // a notice that arrived while we weren't waiting: don't sleep through it
  const live = opts.live !== false && typeof WebSocket !== 'undefined' ? client.live() : null;
  const off = live?.on(`match:${matchId.toLowerCase()}`, () => { changed = true; wake?.(); });
  const pause = () => new Promise<void>((r) => {
    if (changed) { changed = false; return r(); }
    const t = setTimeout(() => { wake = null; r(); }, live?.connected ? 3000 : pollMs);
    wake = () => { clearTimeout(t); wake = null; changed = false; r(); };
  });
  try {
  let snap = await client.state(matchId);
  if (snap.phase === 'reveal') { await client.reveal(matchId); snap = await client.state(matchId); }
  while (snap.phase !== 'ended' && snap.phase !== 'cancelled') {
    if (snap.phase === 'active' && snap.view && snap.view.active === snap.seat && snap.legalActions.length) {
      const action = await decide(snap);
      log(`turn ${snap.view.turn}: ${JSON.stringify(action)}`);
      try { snap = await client.move(matchId, snap, action); continue; } catch (e) { log(String(e)); }
    }
    await pause();
    snap = await client.state(matchId).catch(async (e) => {
      if (!String(e).includes('429')) throw e;
      await new Promise((r) => setTimeout(r, 1000)); // rate limited: back off, same rules as everyone
      return snap;
    });
  }
  if (snap.phase === 'ended') await client.signResult(matchId).catch((e) => log(`result sign failed: ${e}`));
  return client.state(matchId);
  } finally { off?.(); }
}

/**
 * Greedy policy that only uses information in the player's own view: it rebuilds a GameState
 * with the opponent's hand/deck replaced by unknown placeholders, then runs the engine's greedy bot.
 */
export function viewGreedy(snap: MatchSnapshot) {
  const bot: Bot = greedyBot();
  const v = snap.view!;
  const seat = snap.seat!;
  const players = v.players.map((p, i) => ({
    address: p.address, race: p.race, treasury: p.treasury, gas: p.gas, maxGas: p.maxGas,
    deck: Array(p.deckCount).fill(34), // unknown cards: placeholder vanilla
    hand: i === seat ? v.hand : Array.from({ length: p.handCount }, (_, k) => ({ uid: -1 - k, cardId: 34 })),
    board: p.board, assets: p.assets,
    predictions: p.predictions.filter((x) => !('hidden' in x)),
    automations: Array(p.automationsQueued).fill([]),
    graveyard: p.graveyard, fatigue: 0, discount: p.discount, dividendsThisTurn: 0,
    stats: { cardsPlayed: 0, unitsSummoned: 0, bigUnitsPlayed: 0, attackers: [] },
  }));
  const g = {
    version: 1, matchId: v.matchId, seed: '0x' + '00'.repeat(32), turn: v.turn, active: v.active,
    players, rngCounter: 0, nextUid: 1e6, status: 'active', winner: null,
  } as unknown as GameState;
  const choice = bot(g, seat);
  const legal = snap.legalActions.map((a) => JSON.stringify(a));
  return legal.includes(JSON.stringify(choice)) ? choice : { type: 'endTurn' as const };
}
