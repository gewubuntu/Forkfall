import { describe, expect, it } from 'vitest';
import { applyAction, card, createLesson, createTutorial, LESSONS, tutorialBotMove } from '../src/index.ts';
import { playLesson, playRandom } from './student.ts';

describe('lessons', () => {
  it('stacks the basics: you start with Compute Node, Launch Bot and Bridge Runner; the bot Treasury is 12', () => {
    const { state } = createTutorial();
    expect(state.active).toBe(0);
    expect(state.players[0].hand.map((h) => h.cardId)).toEqual([2, 1, 37, 3]);
    expect(state.players[1].treasury).toBe(12);
    expect(state.players[0].gas).toBe(1);
  });

  it.each(LESSONS.map((l) => l.id))('%s: a student who follows the coach meets every step in order and wins', (id) => {
    const { g, seen, steps } = playLesson(id);
    expect(g.winner).toBe(0);
    expect(g.turn).toBeLessThanOrEqual(11);
    expect(seen).toEqual(steps);
  });

  it('starts units in play: the Prophets bot has a Compute Node, the Brokers student an Analyst', () => {
    expect(createLesson('prophets').state.players[1].board.map((u) => u.cardId)).toEqual([2]);
    expect(createLesson('brokers').state.players[0].board.map((u) => u.cardId)).toEqual([19]);
  });

  it('teaches each mechanic for real: the first prediction hits, Analyst holds and pays a Dividend, Rug Pull goes through a Guard', () => {
    const prophets = playLesson('prophets').all;
    expect(prophets.find((e) => e.t === 'predictionResolved')).toMatchObject({ seat: 0, hit: true });
    const brokers = playLesson('brokers').all;
    const t3 = brokers.slice(brokers.findIndex((e) => e.t === 'turnStart' && e.turn === 3), brokers.findIndex((e) => e.t === 'turnStart' && e.turn === 4));
    expect(t3.findIndex((e) => e.t === 'hold' && e.seat === 0)).toBeGreaterThan(-1);
    expect(t3.filter((e) => e.t === 'draw' && e.seat === 0).length).toBe(2); // turn draw + Dividend
    const degens = playLesson('degens');
    const rug = degens.all.findIndex((e) => e.t === 'play' && e.cardId === 29);
    expect(degens.all.slice(rug, rug + 2).some((e) => e.t === 'damage' && e.seat === 1 && e.uid === 'treasury')).toBe(true);
  });

  it('forbids moves that would derail a lesson', () => {
    const brokers = LESSONS.find((l) => l.id === 'brokers')!;
    const g = createLesson('brokers').state;
    expect(brokers.steps[1].forbid!(g, { type: 'attack', attacker: 1, target: 'treasury' })).toMatch(/holding/);
    const prophets = LESSONS.find((l) => l.id === 'prophets')!;
    expect(prophets.steps[1].forbid!(g, { type: 'play', uid: 1, condition: 'plays3Cards' })).toMatch(/attacks/);
    expect(prophets.steps[1].forbid!(g, { type: 'play', uid: 1, condition: 'attacks' })).toBeNull();
  });

  it('never locks a student out of attacking, even off script', () => {
    // Brokers: skip Bond Desk on turn 3 (play the second Intern instead). The attack ban is only for turn 3, so
    // the student attacks on turn 5 and still wins with every step in order.
    const brokers = playLesson('brokers', false, (g, legal, step) => {
      if (step !== 'guard') return undefined;
      return legal.find((a) => a.type === 'play' && g.players[0].hand.find((h) => h.uid === a.uid)?.cardId !== 18 && !a.target);
    });
    const t5 = brokers.all.findIndex((e) => e.t === 'turnStart' && e.turn === 5);
    expect(brokers.all.slice(0, t5).some((e) => e.t === 'play' && e.cardId === 18)).toBe(false);
    expect(brokers.all.slice(t5).some((e) => e.t === 'attack' && e.seat === 0)).toBe(true);
    expect(brokers.g.winner).toBe(0);
    expect(brokers.seen).toEqual(brokers.steps);
    // A full board makes Bond Desk unplayable: the ban lifts and the step counts as done.
    const guard = LESSONS.find((l) => l.id === 'brokers')!.steps.find((x) => x.id === 'guard')!;
    const full = structuredClone(createLesson('brokers').state);
    full.turn = 3;
    full.players[0].hand.push({ uid: 900, cardId: 18 });
    while (full.players[0].board.length < 5) full.players[0].board.push({ ...full.players[0].board[0], uid: 901 + full.players[0].board.length });
    expect(guard.forbid!(full, { type: 'attack', attacker: full.players[0].board[0].uid, target: 'treasury' })).toBeNull();
    expect(guard.done!(full, [], [])).toBe(true);
    // Random students who obey every rule: attacks are never banned for more than two of their turns in a row.
    for (const l of LESSONS) {
      for (let seed = 1; seed <= 300; seed++) expect(playRandom(l.id, seed).longestBan, `${l.id} seed ${seed}`).toBeLessThanOrEqual(2);
    }
  });

  it('keeps the Ape step on track: Pump Frog must be Aped, and Show me finds an Ape play', () => {
    const degens = LESSONS.find((l) => l.id === 'degens')!;
    const ape = degens.steps.find((s) => s.id === 'ape')!;
    const g = createLesson('degens').state;
    const frog = g.players[0].hand.find((h) => h.cardId === 27)!.uid;
    expect(ape.forbid!(g, { type: 'play', uid: frog })).toMatch(/Ape in/);
    expect(ape.forbid!(g, { type: 'play', uid: frog, ape: true })).toBeNull();
  });

  it('the basics bot lands its Guard on its second turn', () => {
    let g = createTutorial().state;
    g = applyAction(g, 0, { type: 'endTurn' }).state;
    for (let turn = 0; turn < 2;) {
      const a = g.active === 1 ? tutorialBotMove(g) : { type: 'endTurn' as const };
      if (g.active === 1 && a.type === 'endTurn') turn++;
      g = applyAction(g, g.active, a).state;
    }
    expect(g.players[1].board.some((u) => u.cardId === 33)).toBe(true);
  });
  it('quotes card stats as the cards have them, so balance changes reach the lessons', () => {
    const steps = LESSONS.find((l) => l.id === 'brokers')!.steps;
    const bond = card(18), ci = card(22).onPlay!.find((e) => e.k === 'buff')!;
    expect(steps.find((s) => s.id === 'guard')!.body).toContain(`a ${bond.attack}/${bond.health} Guard`);
    expect(ci.k === 'buff' && steps.find((s) => s.id === 'compound')!.body).toContain(`+${ci.k === 'buff' ? ci.atk : 0}/+${ci.k === 'buff' ? ci.hp : 0}`);
  });
});
