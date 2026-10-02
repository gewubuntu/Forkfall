import { describe, expect, it } from 'vitest';
import {
  advanceTutorial, applyAction, createTutorial, legalActions, tutorialBotMove, TUTORIAL_STEPS,
  type Action, type GameEvent, type GameState,
} from '../src/index.ts';

/** Plays the tutorial as a student who follows the coach. */
function playThrough() {
  let g: GameState = createTutorial().state;
  let step = 0; let since: GameEvent[] = []; const all: GameEvent[] = [];
  const seen: string[] = [];
  const tick = () => {
    for (;;) {
      if (TUTORIAL_STEPS[step]?.next) { seen.push(TUTORIAL_STEPS[step].id); step++; since = []; continue; }
      const n = advanceTutorial(step, g, since, all);
      if (n === step) return;
      for (let i = step; i < n; i++) seen.push(TUTORIAL_STEPS[i].id);
      step = n; since = [];
    }
  };
  const act = (seat: 0 | 1, a: Action) => { const r = applyAction(g, seat, a); g = r.state; since.push(...r.events); all.push(...r.events); tick(); };
  tick();
  for (let i = 0; i < 300 && g.status === 'active'; i++) {
    if (g.active === 1) { act(1, tutorialBotMove(g)); continue; }
    const acts = legalActions(g, 0);
    const h = (id: number) => g.players[0].hand.find((x) => x.cardId === id);
    const want = (id: number, target?: number) => acts.find((a) => a.type === 'play' && a.uid === h(id)?.uid && (target === undefined || a.target === target));
    const guard = g.players[1].board.find((u) => u.keywords.includes('guard'));
    act(0, want(2) ?? want(1) ?? (guard && want(36, guard.uid)) ?? want(37) ?? want(3) ?? want(5) ?? want(34)
      ?? acts.find((x) => x.type === 'attack' && x.target === 'treasury') ?? acts.find((x) => x.type === 'attack') ?? { type: 'endTurn' });
  }
  return { g, seen };
}

describe('tutorial', () => {
  it('stacks the decks: you start with Compute Node, Launch Bot and Bridge Runner; the bot Treasury is 12', () => {
    const { state } = createTutorial();
    expect(state.active).toBe(0);
    expect(state.players[0].hand.map((h) => h.cardId)).toEqual([2, 1, 37, 3]);
    expect(state.players[1].treasury).toBe(12);
    expect(state.players[0].gas).toBe(1);
  });
  it('a student who follows the coach meets every lesson in order and wins in about five turns', () => {
    const { g, seen } = playThrough();
    expect(g.winner).toBe(0);
    expect(g.turn).toBeLessThanOrEqual(11);
    expect(seen).toEqual(TUTORIAL_STEPS.map((s) => s.id).slice(0, seen.length));
    expect(seen).toEqual(expect.arrayContaining(['gas', 'compute', 'attack', 'guard', 'face', 'rush', 'win']));
  });
  it('the bot lands its Guard on its second turn', () => {
    let g = createTutorial().state;
    g = applyAction(g, 0, { type: 'endTurn' }).state;
    for (let turn = 0; turn < 2;) {
      const a = g.active === 1 ? tutorialBotMove(g) : { type: 'endTurn' as const };
      if (g.active === 1 && a.type === 'endTurn') turn++;
      g = applyAction(g, g.active, a).state;
    }
    expect(g.players[1].board.some((u) => u.cardId === 33)).toBe(true);
  });
});
