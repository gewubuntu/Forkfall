import { card } from './cards.ts';
import { applyAction, attackTargets, canAttack, createScriptedMatch, legalActions } from './engine.ts';
import type { Action, GameEvent, GameState } from './types.ts';

/**
 * The guided first match: you play Agents against a gentle scripted Degens bot. Decks are stacked so every
 * lesson has the right cards at the right time, and the bot's Treasury starts at 12 so it takes ~5 turns.
 * Runs entirely in the browser (no wallet, no server); the same engine rules as real matches.
 */
export const TUTORIAL_YOU = 0 as const;
export const TUTORIAL_BOT = 1 as const;

/** Your draw order: opening hand Compute Node, Launch Bot, Bridge Runner; then Cron Job, Liquidator, Swarm Deployer… */
const YOUR_DECK = [2, 1, 37, 3, 36, 5, 34, 1, 37, 5, 34, 4, 1, 34, 5];
/** The bot's: Meme Critter, Cold Wallet (Guard), Paper Hands (Rush), Meme Critter; then fillers. */
const BOT_DECK = [25, 33, 26, 25, 34, 27, 25, 34, 26, 25, 34, 27, 25, 34, 26];

export function createTutorial(): { state: GameState; events: GameEvent[] } {
  return createScriptedMatch({
    matchId: 'tutorial',
    players: [
      { address: '0x' + '1'.repeat(40), race: 'agents', deck: YOUR_DECK },
      { address: '0x' + '2'.repeat(40), race: 'degens', deck: BOT_DECK },
    ],
    first: TUTORIAL_YOU,
    treasury: [25, 12],
  });
}

/** The bot's next move: play its cards in the stacked order (so Cold Wallet lands when the Guard lesson starts),
 *  attack your Treasury (or the Guard in the way), end turn. */
export function tutorialBotMove(g: GameState): Action {
  const seat = TUTORIAL_BOT;
  const acts = legalActions(g, seat);
  const plays = acts.filter((a): a is Extract<Action, { type: 'play' }> => a.type === 'play' && !a.ape && !a.condition && a.target === undefined);
  const hand = g.players[seat].hand;
  const firstPlayable = hand.find((h) => card(h.cardId).cost <= g.players[seat].gas);
  if (firstPlayable && hand.indexOf(firstPlayable) === 0) {
    const p = plays.find((a) => a.uid === firstPlayable.uid);
    if (p) return p;
  }
  for (const u of g.players[seat].board) {
    if (!canAttack(g, seat, u)) continue;
    const targets = attackTargets(g, seat);
    return { type: 'attack', attacker: u.uid, target: targets.includes('treasury') ? 'treasury' : targets[0] };
  }
  return { type: 'endTurn' };
}

export interface TutorialStep {
  id: string;
  title: string;
  body: string;
  /** CSS selector of the thing to point at. */
  target?: string;
  /** Advance with a Next button (no action needed). */
  next?: boolean;
  /** Advance once this is true, given the state, the events since the step began, and every event so far. */
  done?: (g: GameState, events: GameEvent[], all: GameEvent[]) => boolean;
}

const mine = (e: GameEvent): boolean => 'seat' in e && e.seat === TUTORIAL_YOU;
const played = (id: number) => (_g: GameState, _ev: GameEvent[], all: GameEvent[]) => all.some((e) => e.t === 'play' && mine(e) && e.cardId === id);
const myTurnStarted = (_g: GameState, ev: GameEvent[]) => ev.some((e) => e.t === 'turnStart' && e.seat === TUTORIAL_YOU);

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'welcome', next: true, title: 'Welcome to Forkfall',
    body: 'Two players, two Treasuries. Bring your opponent’s Treasury to 0 to win. You play the Agents, a race of bots and drones. This practice bot is gentle.',
  },
  {
    id: 'treasury', next: true, target: '[data-treasury="1"]', title: 'The Treasury',
    body: 'This is the bot’s Treasury: 12 today (real matches start at 25). Units and spells chip it down. Yours is below; protect it.',
  },
  {
    id: 'gas', target: '.tut-hand', done: played(2), title: 'Gas pays for cards',
    body: 'You have 1 Gas this turn, and 1 more every turn (up to 10). The number on a card is its cost. Play Compute Node: it costs 1.',
  },
  {
    id: 'end1', target: '.end-turn', done: myTurnStarted, title: 'End your turn',
    body: 'New units can’t attack on the turn they arrive. Nothing left to do, so end your turn and watch the bot.',
  },
  {
    id: 'compute', target: '.tut-hand', done: (_g, _ev, all) => all.some((e) => e.t === 'summon' && mine(e) && e.cardId === 1000), title: 'Combos: Compute and Deploy',
    body: 'Compute Node made your next card 1 cheaper, so Launch Bot costs 1. Play it: Deploy summons a free Drone too.',
  },
  {
    id: 'attack', target: '.lane.me-lane', done: (_g, _ev, all) => all.some((e) => e.t === 'attack' && mine(e)), title: 'Attack!',
    body: 'Compute Node has been on the board for a turn, so it can attack (it shows READY). Click it, then click a target: the bot’s Meme Critter or its Treasury.',
  },
  {
    id: 'end2', target: '.end-turn', done: myTurnStarted, title: 'End your turn',
    body: 'Units attack once per turn. End your turn.',
  },
  {
    id: 'guard', target: '.lane.opp-lane', title: 'Guard blocks the way',
    done: (g, _ev, all) => all.some((e) => e.t === 'death' && e.cardId === 33) || (g.turn > 6 && !g.players[TUTORIAL_BOT].board.some((u) => u.keywords.includes('guard'))),
    body: 'The bot played Cold Wallet. It has Guard: you must defeat it before you can hit anything else. Cast Liquidator on it (3 damage), then finish it with an attack.',
  },
  {
    id: 'face', target: '[data-treasury="1"]', done: (_g, ev) => ev.some((e) => e.t === 'damage' && e.seat === TUTORIAL_BOT && e.uid === 'treasury'), title: 'Go for the Treasury',
    body: 'The Guard is gone. Attack the bot’s Treasury with your other units. If they already attacked this turn, end your turn and do it next turn.',
  },
  {
    id: 'rush', target: '.tut-hand', done: played(37), title: 'Rush and Automate',
    body: 'Bridge Runner has Rush: it can attack the turn it’s played. Play it and swing at the Treasury. Cron Job is the Agents’ trick: Automate deals 2 damage at the start of your next turn, even if you do nothing.',
  },
  {
    id: 'win', target: '[data-treasury="1"]', done: (g) => g.status === 'ended', title: 'Finish it',
    body: 'Keep attacking until the bot’s Treasury hits 0. Hover any card to read it on the right.',
  },
];

/** Moves past every completed action step (Next steps wait for the button). Steps only move forward. */
export function advanceTutorial(stepIndex: number, g: GameState, eventsSinceStep: GameEvent[], all: GameEvent[]): number {
  let i = stepIndex;
  for (;;) {
    const s = TUTORIAL_STEPS[i];
    if (!s || s.next || !s.done) return i;
    if (!s.done(g, i === stepIndex ? eventsSinceStep : [], all)) return i;
    i++;
  }
}

export { applyAction as applyTutorialAction };
