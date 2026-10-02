import {
  advanceLesson, applyAction, createLesson, legalActions, lessonById, tutorialBotMove,
  type Action, type GameEvent, type GameState, type LessonId,
} from '../src/index.ts';

/** Greedy fallback: play something (no Ape, no prediction), then attack, then end turn. */
function greedy(g: GameState, legal: Action[]): Action {
  return legal.find((a) => a.type === 'play' && !a.ape && !a.condition)
    ?? legal.find((a) => a.type === 'attack' && a.target === 'treasury')
    ?? legal.find((a) => a.type === 'attack')
    ?? { type: 'endTurn' };
}

/** Plays a lesson as a student who does what the coach says (Next, then each step's move), within its rules. */
export function playLesson(id: LessonId, log = false) {
  const l = lessonById(id)!;
  let g: GameState = createLesson(id).state;
  let step = 0; let since: GameEvent[] = []; const all: GameEvent[] = [];
  const seen: string[] = [];
  const tick = () => {
    for (;;) {
      if (l.steps[step]?.next) { seen.push(l.steps[step].id); step++; since = []; continue; }
      const n = advanceLesson(l.steps, step, g, since, all);
      if (n === step) return;
      for (let i = step; i < n; i++) seen.push(l.steps[i].id);
      step = n; since = [];
    }
  };
  const act = (seat: 0 | 1, a: Action) => {
    const r = applyAction(g, seat, a); g = r.state; since.push(...r.events); all.push(...r.events);
    if (log) console.log(`t${g.turn} s${seat} ${JSON.stringify(a)} | step=${l.steps[step]?.id} | treasury ${g.players.map((p) => p.treasury)}`);
    tick();
  };
  tick();
  for (let i = 0; i < 400 && g.status === 'active'; i++) {
    if (g.active === 1) { act(1, tutorialBotMove(g)); continue; }
    const s = l.steps[step];
    const legal = legalActions(g, 0).filter((a) => !s?.forbid?.(g, a));
    act(0, s?.auto?.(g, legal) ?? greedy(g, legal));
  }
  return { g, seen, all, steps: l.steps.map((s) => s.id) };
}
