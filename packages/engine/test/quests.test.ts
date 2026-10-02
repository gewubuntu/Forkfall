import { describe, expect, it } from 'vitest';
import {
  applyAction, card, createMatch, dailyQuests, greedyBot, matchCounts, packPeriod, quest, questDay, QUESTS, QUESTS_PER_DAY, starterDeck,
  type GameEvent, type GameState, type QuestMatch, type Race,
} from '../src/index.ts';

/** A full greedy-vs-greedy match with its event log. */
function playMatch(a: Race, b: Race, salt: string) {
  let g: GameState; const events: GameEvent[] = [];
  const r = createMatch({
    matchId: `quests-${salt}`, seed: `0x${'ab'.repeat(32)}`,
    players: [{ address: '0x' + '1'.repeat(40), race: a, deck: starterDeck(a), deckSalt: salt }, { address: '0x' + '2'.repeat(40), race: b, deck: starterDeck(b), deckSalt: salt + 'b' }],
  });
  g = r.state; events.push(...r.events);
  const bot = greedyBot();
  for (let i = 0; i < 2000 && g.status === 'active'; i++) {
    const x = applyAction(g, g.active, bot(g, g.active)); g = x.state; events.push(...x.events);
  }
  return { g, events };
}

describe('daily quests', () => {
  it('gives each player three quests a day, one per group, the same on every call', () => {
    const qs = dailyQuests('0xAbC0000000000000000000000000000000000001', 20_000);
    expect(qs).toHaveLength(QUESTS_PER_DAY);
    expect(qs.map((q) => q.group)).toEqual(['win', 'play', 'race']);
    expect(dailyQuests('0xabc0000000000000000000000000000000000001', 20_000).map((q) => q.id)).toEqual(qs.map((q) => q.id));
    // Different days and players get different sets (over a few weeks, not always identical).
    const days = new Set(Array.from({ length: 21 }, (_, d) => dailyQuests('0x1', 20_000 + d).map((q) => q.id).join()));
    expect(days.size).toBeGreaterThan(5);
  });

  it('a reroll swaps one slot for a different quest of the same group', () => {
    const before = dailyQuests('0x1', 20_000);
    const after = dailyQuests('0x1', 20_000, [0, 1, 0]);
    expect(after[0].id).toBe(before[0].id);
    expect(after[1].id).not.toBe(before[1].id);
    expect(after[1].group).toBe('play');
  });

  it('counts progress from a real match, from each side', () => {
    const { g, events } = playMatch('agents', 'degens', 'x');
    expect(g.status).toBe('ended');
    const side = (seat: 0 | 1): QuestMatch => ({ seat, won: g.winner === seat, race: g.players[seat].race, turns: g.turn, events });
    const winner = side(g.winner as 0 | 1);
    const loser = side(g.winner === 0 ? 1 : 0);
    expect(matchCounts(winner)).toBe(true);
    expect(quest('win2')!.progress(winner)).toBe(1);
    expect(quest('win2')!.progress(loser)).toBe(0);
    expect(quest('play3')!.progress(loser)).toBe(1);
    // Cross-check the counters against the raw events.
    const playsOf = (seat: number) => events.filter((e): e is Extract<GameEvent, { t: 'play' }> => e.t === 'play' && e.seat === seat);
    expect(quest('units10')!.progress(side(0))).toBe(playsOf(0).filter((e) => card(e.cardId).type === 'unit').length);
    const dealt = events.filter((e): e is Extract<GameEvent, { t: 'damage' }> => e.t === 'damage' && e.seat === 1 && e.uid === 'treasury').reduce((a, e) => a + e.n, 0);
    expect(quest('damage20')!.progress(side(0))).toBe(dealt);
    expect(quest('deploy6')!.progress(side(0))).toBeGreaterThan(0); // Agents deploy Drones
    expect(quest('win-agents')!.progress(side(0))).toBe(g.winner === 0 ? 1 : 0);
  });

  it('ignores matches shorter than four turns each', () => {
    expect(matchCounts({ turns: 7 })).toBe(false);
    expect(matchCounts({ turns: 8 })).toBe(true);
  });

  it('pack periods start on Mondays and can be weekly or biweekly', () => {
    const monday = questDay(Date.UTC(2026, 8, 28)); // Mon 28 Sep 2026
    expect(packPeriod(monday).first).toBe(monday);
    expect(packPeriod(monday + 6).first).toBe(monday);
    expect(packPeriod(monday + 7).first).toBe(monday + 7);
    const two = packPeriod(monday + 3, 14);
    expect(two.last - two.first).toBe(13);
    expect(new Date(two.first * 86_400_000).getUTCDay()).toBe(1);
  });

  it('every quest is reachable and pays a sane amount', () => {
    for (const q of QUESTS) {
      expect(q.goal).toBeGreaterThan(0);
      expect(q.scrap).toBeGreaterThanOrEqual(20);
      expect(q.scrap).toBeLessThanOrEqual(50);
    }
  });
});
