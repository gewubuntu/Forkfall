import { describe, expect, it } from 'vitest';
import { applyAction, createLesson, createTutorial, LESSONS, tutorialBotMove } from '../src/index.ts';
import { playLesson } from './student.ts';

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
});
