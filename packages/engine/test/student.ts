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
export function playLesson(id: LessonId, log = false, choose?: (g: GameState, legal: Action[], step: string | undefined) => Action | undefined) {
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
    act(0, choose?.(g, legal, s?.id) ?? s?.auto?.(g, legal) ?? greedy(g, legal));
  }
  return { g, seen, all, steps: l.steps.map((s) => s.id), step: () => l.steps[step] };
}

/** A random student (deterministic per seed) who still obeys the lesson's rules. Reports the longest run of
 *  own turns in which the student was locked: every attack banned and nothing left that would move the lesson on. */
export function playRandom(id: LessonId, seed: number) {
  let x = seed * 2654435761 % 2 ** 32 || 1;
  const rnd = (n: number) => { x = (x * 1664525 + 1013904223) % 2 ** 32; return x % n; };
  const l = lessonById(id)!;
  let g: GameState = createLesson(id).state;
  let step = 0; let since: GameEvent[] = []; const all: GameEvent[] = [];
  let banned = 0; let longestBan = 0; let bannedThisTurn = false;
  const tick = () => {
    for (;;) {
      if (l.steps[step]?.next) { step++; since = []; continue; }
      const n = advanceLesson(l.steps, step, g, since, all);
      if (n === step) return;
      step = n; since = [];
    }
  };
  tick();
  for (let i = 0; i < 600 && g.status === 'active'; i++) {
    let a: Action;
    if (g.active === 1) a = tutorialBotMove(g);
    else {
      const all0 = legalActions(g, 0);
      const s = l.steps[step];
      const legal = all0.filter((x) => !s?.forbid?.(g, x));
      if (all0.some((x) => x.type === 'attack') && !legal.some((x) => x.type === 'attack') && !s?.auto?.(g, legal)) bannedThisTurn = true;
      a = legal[rnd(legal.length)];
      if (a.type === 'endTurn') { banned = bannedThisTurn ? banned + 1 : 0; longestBan = Math.max(longestBan, banned); bannedThisTurn = false; }
    }
    const r = applyAction(g, g.active, a); g = r.state; since.push(...r.events); all.push(...r.events); tick();
  }
  return { g, longestBan };
}
