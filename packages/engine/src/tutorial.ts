import { card } from './cards.ts';
import { applyAction, attackTargets, canAttack, createScriptedMatch, legalActions } from './engine.ts';
import type { Action, GameEvent, GameState, PredictionCondition, Race } from './types.ts';

/**
 * Lessons: guided matches against a gentle scripted bot. "basics" is the first match everyone plays (Gas,
 * units, attacking, Guard, Rush); each race then has its own lesson for its signature mechanic. Decks are
 * stacked (no shuffle) so every step has the right cards at the right time, some units start on the board,
 * and the bot's Treasury is low so a lesson takes ~5 turns. Runs entirely in the browser with the real rules.
 */
export const TUTORIAL_YOU = 0 as const;
export const TUTORIAL_BOT = 1 as const;

type Play = Extract<Action, { type: 'play' }>;

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
  /** The move that completes this step (or progresses it), for "Show me" and for tests. */
  auto?: (g: GameState, legal: Action[]) => Action | undefined;
  /** Keeps the lesson on track: a reason to refuse a move, or null to allow it. */
  forbid?: (g: GameState, a: Action) => string | null;
}

export type LessonId = 'basics' | 'prophets' | 'brokers' | 'degens';

export interface Lesson {
  id: LessonId;
  title: string;
  /** One line for the lesson picker. */
  blurb: string;
  race: Race;
  botRace: Race;
  you: number[];
  bot: number[];
  treasury: [number, number];
  board?: [number[], number[]];
  steps: TutorialStep[];
  /** What the win screen says you learned. */
  learned: string;
}

// ─── Step helpers ─────────────────────────────────────────────────
const mine = (e: GameEvent): boolean => 'seat' in e && e.seat === TUTORIAL_YOU;
const played = (id: number) => (_g: GameState, _ev: GameEvent[], all: GameEvent[]) => all.some((e) => e.t === 'play' && mine(e) && e.cardId === id);
const myTurnStarted = (_g: GameState, ev: GameEvent[]) => ev.some((e) => e.t === 'turnStart' && e.seat === TUTORIAL_YOU);
const ended = (g: GameState) => g.status === 'ended';
const handUid = (g: GameState, id: number) => g.players[TUTORIAL_YOU].hand.find((h) => h.cardId === id)?.uid;
const enemyUnits = (g: GameState) => g.players[TUTORIAL_BOT].board;
/** Plays card `id` from hand (optionally with a prediction, Ape, or a target picked by `pick`). */
const playAuto = (id: number, opts: { condition?: PredictionCondition; ape?: boolean; pick?: (g: GameState, targets: number[]) => number | undefined } = {}) =>
  (g: GameState, legal: Action[]): Action | undefined => {
    const uid = handUid(g, id);
    const plays = legal.filter((a): a is Play => a.type === 'play' && a.uid === uid && !!a.ape === !!opts.ape && (opts.condition ? a.condition === opts.condition : !a.condition));
    if (!plays.length) return undefined;
    if (!opts.pick) return plays[0];
    const t = opts.pick(g, plays.map((a) => a.target).filter((x): x is number => typeof x === 'number'));
    return plays.find((a) => a.target === t) ?? plays[0];
  };
const biggest = (g: GameState, seat: 0 | 1) => (_g: GameState, targets: number[]): number | undefined =>
  g.players[seat].board.filter((u) => targets.includes(u.uid)).sort((a, b) => b.attack - a.attack)[0]?.uid;
/** Attack with any ready unit: the Treasury if possible, else whatever must be hit first. */
const attackAuto = (_g: GameState, legal: Action[]): Action | undefined =>
  legal.find((a) => a.type === 'attack' && a.target === 'treasury') ?? legal.find((a) => a.type === 'attack');
const endAuto = (): Action => ({ type: 'endTurn' });
const endStep = (id: string, body: string): TutorialStep => ({ id, target: '.end-turn', done: myTurnStarted, auto: endAuto, title: 'End your turn', body });
const winStep = (body: string): TutorialStep => ({ id: 'win', target: '[data-treasury="1"]', done: ended, title: 'Finish it', body });
const noAttacks = (why: string) => (_g: GameState, a: Action) => (a.type === 'attack' ? why : null);

// ─── Basics: Gas, Compute/Deploy, attacking, Guard, Rush, Automate ───
const BASICS: Lesson = {
  id: 'basics', title: 'The basics', race: 'agents', botRace: 'degens',
  blurb: 'Gas, units, attacking, Guard and Rush. Start here.',
  learned: 'You know the basics: Gas, units, attacking, Guard, Rush and the Agents’ Automate. Each race has its own tricks to discover.',
  // Opening hand Compute Node, Launch Bot, Bridge Runner; then Cron Job, Liquidator, Swarm Deployer…
  you: [2, 1, 37, 3, 36, 5, 34, 1, 37, 5, 34, 4, 1, 34, 5],
  // Meme Critter, Cold Wallet (Guard), Paper Hands (Rush), Meme Critter; then fillers.
  bot: [25, 33, 26, 25, 34, 27, 25, 34, 26, 25, 34, 27, 25, 34, 26],
  treasury: [25, 12],
  steps: [
    {
      id: 'welcome', next: true, title: 'Welcome to Forkfall',
      body: 'Two players, two Treasuries. Bring your opponent’s Treasury to 0 to win. You play the Agents, a race of bots and drones. This practice bot is gentle.',
    },
    {
      id: 'treasury', next: true, target: '[data-treasury="1"]', title: 'The Treasury',
      body: 'This is the bot’s Treasury: 12 today (real matches start at 25). Units and spells chip it down. Yours is below; protect it.',
    },
    {
      id: 'gas', target: '.tut-hand', done: played(2), auto: playAuto(2), title: 'Gas pays for cards',
      body: 'You have 1 Gas this turn, and 1 more every turn (up to 10). The number on a card is its cost. Play Compute Node: it costs 1.',
    },
    endStep('end1', 'New units can’t attack on the turn they arrive. Nothing left to do, so end your turn and watch the bot.'),
    {
      id: 'compute', target: '.tut-hand', done: (_g, _ev, all) => all.some((e) => e.t === 'summon' && mine(e) && e.cardId === 1000), auto: playAuto(1),
      title: 'Combos: Compute and Deploy',
      body: 'Compute Node made your next card 1 cheaper, so Launch Bot costs 1. Play it: Deploy summons a free Drone too.',
    },
    {
      id: 'attack', target: '.lane.me-lane', done: (_g, _ev, all) => all.some((e) => e.t === 'attack' && mine(e)), auto: attackAuto, title: 'Attack!',
      body: 'Compute Node has been on the board for a turn, so it can attack (it shows READY). Click it, then click a target: the bot’s Meme Critter or its Treasury.',
    },
    endStep('end2', 'Units attack once per turn. End your turn.'),
    {
      id: 'guard', target: '.lane.opp-lane', title: 'Guard blocks the way',
      done: (g, _ev, all) => all.some((e) => e.t === 'death' && e.cardId === 33) || (g.turn > 6 && !enemyUnits(g).some((u) => u.keywords.includes('guard'))),
      auto: (g, legal) => playAuto(36, { pick: (gg, t) => t.find((x) => enemyUnits(gg).some((u) => u.uid === x && u.cardId === 33)) })(g, legal) ?? attackAuto(g, legal),
      body: 'The bot played Cold Wallet. It has Guard: you must defeat it before you can hit anything else. Cast Liquidator on it (3 damage), then finish it with an attack.',
    },
    {
      id: 'face', target: '[data-treasury="1"]', done: (_g, ev) => ev.some((e) => e.t === 'damage' && e.seat === TUTORIAL_BOT && e.uid === 'treasury'),
      auto: (g, legal) => attackAuto(g, legal) ?? endAuto(), title: 'Go for the Treasury',
      body: 'The Guard is gone. Attack the bot’s Treasury with your other units. If they already attacked this turn, end your turn and do it next turn.',
    },
    {
      id: 'rush', target: '.tut-hand', done: played(37), auto: (g, legal) => playAuto(37)(g, legal) ?? endAuto(), title: 'Rush and Automate',
      body: 'Bridge Runner has Rush: it can attack the turn it’s played. Play it and swing at the Treasury. Cron Job is the Agents’ trick: Automate deals 2 damage at the start of your next turn, even if you do nothing.',
    },
    winStep('Keep attacking until the bot’s Treasury hits 0. Hover any card to read it on the right.'),
  ],
};

// ─── Prophets: predictions, Odds tiers, backfire, payoffs ─────────
const PROPHETS: Lesson = {
  id: 'prophets', title: 'Prophets: predictions', race: 'prophets', botRace: 'agents',
  blurb: 'Call what your opponent does next. Right pays, wrong backfires.',
  learned: 'You can read the future: face-down predictions, Odds tiers, backfire, and cards that reward an active prediction.',
  // Opening hand Tea Leaves, Seer's Acolyte, Called It; then Tea Leaves, Oracle Guard, Star Chart…
  you: [9, 10, 13, 9, 12, 11, 10, 34, 9, 13, 12, 34, 10, 11, 34],
  // Launch Bot, Validator…: nothing it can afford on its first turn, so only the Compute Node already in play attacks.
  bot: [1, 34, 1, 34, 34, 1, 5, 34, 1, 34, 5, 1, 34, 1, 34],
  board: [[], [2]],
  treasury: [25, 12],
  steps: [
    {
      id: 'welcome', next: true, title: 'The Prophets',
      body: 'Prophets trade on the future. A prediction is a face-down guess about what your opponent does on their next turn. Call it right and it pays out; call it wrong and it backfires on you.',
    },
    {
      id: 'foresee', target: '.tut-hand', done: (_g, _ev, all) => all.some((e) => e.t === 'predictionMade' && mine(e)),
      auto: playAuto(9, { condition: 'attacks' }), title: 'Foresee',
      forbid: (_g, a) => (a.type === 'play' && a.condition && a.condition !== 'attacks' ? 'For your first call, pick “Opponent attacks next turn”: this bot always attacks.' : null),
      body: 'The bot already has a Compute Node, and this bot always attacks. Play Tea Leaves and choose “Opponent attacks next turn”.',
    },
    {
      id: 'resolve', target: '.end-turn', done: (_g, _ev, all) => all.some((e) => e.t === 'predictionResolved' && mine(e)), auto: endAuto, title: 'End your turn',
      body: 'Predictions resolve at the end of your opponent’s next turn. End your turn and see if you called it.',
    },
    {
      id: 'payoff', next: true, target: '[data-treasury="1"]', title: 'Odds tiers',
      body: 'Each call has an Odds tier (◆). “Attacks” is tier 1, so Tea Leaves dealt 2 damage. Bolder calls, like “attacks with 2+ units” (◆◆) or “plays 3+ cards” (◆◆◆), pay more. A wrong call backfires: you take damage instead.',
    },
    {
      id: 'acolyte', target: '.tut-hand', done: played(10), auto: playAuto(10), title: 'Seer’s Acolyte',
      body: 'Play Seer’s Acolyte. Every time one of your predictions comes true, it gains +1/+1.',
    },
    endStep('end2', 'End your turn. The bot gets more Gas each turn too.'),
    {
      id: 'calledit', target: '.tut-hand', done: played(13),
      auto: (g, legal) => (g.players[TUTORIAL_YOU].predictions.length ? playAuto(13, { pick: biggest(g, TUTORIAL_BOT) })(g, legal) : playAuto(9, { condition: 'attacks' })(g, legal)),
      title: 'Called It',
      body: 'Called It deals 3 damage to a unit, or 5 while you have an active prediction. First play Tea Leaves again (predict an attack), then Called It on the bot’s Launch Bot.',
    },
    {
      id: 'attack', target: '.lane.me-lane', done: (_g, _ev, all) => all.some((e) => e.t === 'attack' && mine(e)), auto: (g, legal) => attackAuto(g, legal) ?? endAuto(),
      title: 'Pressure',
      body: 'Predictions are strongest with pressure on the board. Attack with Seer’s Acolyte.',
    },
    winStep('Keep predicting and attacking until the bot’s Treasury hits 0. Your face-down calls show under your Treasury; the bot can’t see them.'),
  ],
};

// ─── Brokers: Hold, Dividend, Guard, cashing out ──────────────────
const BROKERS: Lesson = {
  id: 'brokers', title: 'Brokers: Hold and Dividends', race: 'brokers', botRace: 'degens',
  blurb: 'Patient capital: units that don’t attack grow and pay dividends.',
  learned: 'You know the Brokers’ deal: Hold units that skip attacking grow every turn and pay Dividends, and a Guard buys them the time.',
  // Analyst starts in play. Opening hand Intern, Bond Desk, Compound Interest; then Index Fund…
  you: [17, 18, 22, 20, 21, 17, 34, 19, 18, 20, 34, 17, 21, 34, 19],
  // Meme Critter, Paper Hands (Rush)…
  bot: [25, 26, 25, 26, 27, 25, 26, 34, 25, 26, 27, 34, 25, 26, 34],
  board: [[19], []],
  treasury: [25, 12],
  steps: [
    {
      id: 'welcome', next: true, title: 'The Brokers',
      body: 'Brokers are patient capital. Units with Hold grow +1/+1 at the start of your turn if they sat through your whole last turn without attacking, and some pay a Dividend when they do.',
    },
    {
      id: 'hold', target: '.tut-hand', done: played(17), auto: playAuto(17), title: 'Hold',
      forbid: noAttacks('Not this turn: your Analyst is holding. Units with Hold that skip attacking grow.'),
      body: 'Your Analyst is already in play. Leave it be this turn so it holds. Play Intern (1 Gas); it has Hold too.',
    },
    { ...endStep('end1', 'End your turn without attacking.'), forbid: noAttacks('Keep holding: don’t attack this turn.') },
    {
      id: 'dividend', next: true, target: '.lane.me-lane', title: 'Dividends',
      body: 'Analyst held: +1/+1, and its Dividend drew you a card. Intern didn’t grow yet: a unit has to sit through a full turn of yours first.',
    },
    {
      id: 'guard', target: '.tut-hand', done: played(18), auto: playAuto(18), title: 'Protect your investments',
      forbid: noAttacks('Keep holding for one more turn: Intern grows next turn, and Analyst again.'),
      body: 'The bot has a swarm coming. Play Bond Desk: a 0/3 Guard with Hold. Enemy units must hit it first, which keeps your growing units safe.',
    },
    { ...endStep('end2', 'End your turn. The bot’s units have to hit your Guard, not the units you’re growing.'), forbid: noAttacks('Keep holding: don’t attack this turn.') },
    {
      id: 'compound', target: '.tut-hand', done: played(22), auto: (g, legal) => playAuto(22, { pick: biggest(g, TUTORIAL_YOU) })(g, legal), title: 'Compound Interest',
      body: 'Everything held again: Analyst paid another Dividend and Intern grew. Now Compound Interest: give Analyst +2/+2.',
    },
    {
      id: 'cashout', target: '[data-treasury="1"]', done: (_g, ev) => ev.some((e) => e.t === 'damage' && e.seat === TUTORIAL_BOT && e.uid === 'treasury'),
      auto: (g, legal) => attackAuto(g, legal) ?? endAuto(), title: 'Cash out',
      body: 'Time to cash out: attack the Treasury with Analyst. A unit that attacks doesn’t grow next turn. That’s the Brokers’ choice every turn: grow or strike.',
    },
    winStep('Finish the bot. Units you hold back keep growing; units you send keep the pressure on.'),
  ],
};

// ─── Degens: Swarm, Ape, Rug Pull ─────────────────────────────────
const DEGENS: Lesson = {
  id: 'degens', title: 'Degens: Swarm, Ape and Rug Pull', race: 'degens', botRace: 'brokers',
  blurb: 'Cheap swarms, risky Ape plays and a Rug Pull to finish.',
  learned: 'You know how Degens play: Swarm units that grow together, Ape for cheap plays with a random downside, and Rug Pull to go straight through a Guard.',
  // Opening hand Meme Critter, Pump Frog, Meme Critter; then Hype Man, Ape In, Rug Pull, Paper Hands…
  you: [25, 27, 25, 30, 28, 29, 26, 25, 27, 34, 26, 25, 37, 34, 26],
  // Intern, Bond Desk (Guard)…
  bot: [17, 18, 17, 20, 17, 19, 18, 34, 17, 20, 19, 34, 17, 18, 34],
  treasury: [25, 12],
  steps: [
    {
      id: 'welcome', next: true, title: 'The Degens',
      body: 'Degens are meme swarms and launchpad chaos: cheap units that get stronger together, risky plays, and burst damage.',
    },
    {
      id: 'swarm', target: '.tut-hand', done: played(25), auto: playAuto(25), title: 'Swarm',
      body: 'Play Meme Critter. Swarm: it gets +1 attack for each other friendly Swarm unit.',
    },
    endStep('end1', 'End your turn.'),
    {
      id: 'ape', target: '.tut-hand', done: (_g, _ev, all) => all.some((e) => e.t === 'play' && mine(e) && !!e.ape), auto: playAuto(27, { ape: true }), title: 'Ape in',
      body: 'Pump Frog has Ape: play it for 2 less Gas (free here!) with a random downside: lose 2 Treasury, discard a random card, or it enters with −1 health. Click Pump Frog and choose “Ape in”.',
    },
    {
      id: 'swarm2', target: '.tut-hand',
      done: (g) => g.players[TUTORIAL_YOU].board.filter((u) => u.keywords.includes('swarm')).length >= 3 || handUid(g, 25) === undefined,
      auto: playAuto(25), title: 'Grow the swarm',
      body: 'Play your other Meme Critter. With three Swarm units, each one gets +2 attack.',
    },
    {
      id: 'attack', target: '.lane.me-lane', done: (_g, _ev, all) => all.some((e) => e.t === 'attack' && mine(e)), auto: (g, legal) => attackAuto(g, legal) ?? endAuto(),
      title: 'Swarm attack',
      body: 'Your first Meme Critter is ready, and the swarm makes it hit for 3. Attack the Treasury.',
    },
    endStep('end2', 'End your turn.'),
    {
      id: 'rug', target: '.tut-hand', done: played(29), auto: (g, legal) => playAuto(29, { pick: biggest(g, TUTORIAL_YOU) })(g, legal) ?? endAuto(), title: 'Rug Pull',
      body: 'The bot hid behind Bond Desk, a Guard. Rug Pull ignores it: sacrifice a friendly unit and deal its attack +2 straight to the enemy Treasury. Pick your strongest unit.',
    },
    winStep('Finish it: Hype Man pumps the whole swarm, Ape In gives a unit Rush. Break the Guard or go around it.'),
  ],
};

export const LESSONS: Lesson[] = [BASICS, PROPHETS, BROKERS, DEGENS];
export const lessonById = (id: string): Lesson | undefined => LESSONS.find((l) => l.id === id);

export function createLesson(id: LessonId): { state: GameState; events: GameEvent[] } {
  const l = lessonById(id)!;
  return createScriptedMatch({
    matchId: `lesson-${id}`,
    players: [
      { address: '0x' + '1'.repeat(40), race: l.race, deck: l.you },
      { address: '0x' + '2'.repeat(40), race: l.botRace, deck: l.bot },
    ],
    first: TUTORIAL_YOU,
    treasury: l.treasury,
    board: l.board,
  });
}

/** The bot's next move: play its cards in the stacked order (the first card in hand, when affordable), attack
 *  your Treasury (or the Guard in the way) with everything, end turn. Predictable on purpose. */
export function tutorialBotMove(g: GameState): Action {
  const seat = TUTORIAL_BOT;
  const acts = legalActions(g, seat);
  const plays = acts.filter((a): a is Play => a.type === 'play' && !a.ape && !a.condition && a.target === undefined);
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

/** Moves past every completed action step (Next steps wait for the button). Steps only move forward. */
export function advanceLesson(steps: TutorialStep[], stepIndex: number, g: GameState, eventsSinceStep: GameEvent[], all: GameEvent[]): number {
  let i = stepIndex;
  for (;;) {
    const s = steps[i];
    if (!s || s.next || !s.done) return i;
    if (!s.done(g, i === stepIndex ? eventsSinceStep : [], all)) return i;
    i++;
  }
}

// The basics lesson under its original names.
export const TUTORIAL_STEPS = BASICS.steps;
export const createTutorial = () => createLesson('basics');
export const advanceTutorial = (stepIndex: number, g: GameState, eventsSinceStep: GameEvent[], all: GameEvent[]) =>
  advanceLesson(TUTORIAL_STEPS, stepIndex, g, eventsSinceStep, all);
export { applyAction as applyTutorialAction };
