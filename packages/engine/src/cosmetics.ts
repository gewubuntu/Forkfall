import { COLLECTIBLE, RACES, setOf } from './cards.ts';
import { LESSONS } from './tutorial.ts';
import type { CardDef } from './types.ts';

/**
 * Milestone cosmetics: purely visual, never power. Card backs for owning every Common of a set, titles for
 * owning every card, animated badges for the full playset (2 of each, 1 Legendary), the Graduate title for
 * finishing the tutorial and the Scholar title for finishing every lesson. Shared by the server (which checks unlocks against on-chain balances before you can
 * equip one) and the web app (which shows progress and lets you equip).
 */
export type CosmeticKind = 'title' | 'cardBack' | 'badge';
export type MilestoneRule = 'tutorial' | 'lessons' | 'commons' | 'every' | 'playset';

export interface CosmeticSet { key: string; label: string; cards: CardDef[] }
export interface Cosmetic { id: string; kind: CosmeticKind; name: string; set?: string; rule: MilestoneRule; description: string }

const RACE_LABEL: Record<string, string> = { agents: 'Agents', prophets: 'Prophets', brokers: 'Brokers', degens: 'Degens' };

export const COSMETIC_SETS: CosmeticSet[] = [
  ...RACES.map((r) => ({ key: r, label: RACE_LABEL[r], cards: COLLECTIBLE.filter((c) => c.faction === r && setOf(c) === 'core') })),
  { key: 'neutral', label: 'Neutral', cards: COLLECTIBLE.filter((c) => c.faction === 'neutral' && setOf(c) === 'core') },
  { key: 'poncho', label: 'Poncho', cards: COLLECTIBLE.filter((c) => setOf(c) === 'poncho') },
];

const TITLES: Record<string, string> = {
  agents: 'Bot Wrangler', prophets: 'Oracle', brokers: 'Market Maker', degens: 'Degen Royalty', neutral: 'Validator', poncho: 'Taco Connoisseur',
};

export const COSMETICS: Cosmetic[] = [
  { id: 'title:graduate', kind: 'title', name: 'Graduate', rule: 'tutorial', description: 'Finish the tutorial.' },
  { id: 'title:scholar', kind: 'title', name: 'Scholar', rule: 'lessons', description: 'Finish every lesson: the basics and one per race.' },
  ...COSMETIC_SETS.flatMap((s): Cosmetic[] => [
    { id: `back:${s.key}`, kind: 'cardBack', name: `${s.label} card back`, set: s.key, rule: 'commons', description: `Own every ${s.label} Common.` },
    { id: `title:${s.key}`, kind: 'title', name: TITLES[s.key], set: s.key, rule: 'every', description: `Own every ${s.label} card.` },
    { id: `badge:${s.key}`, kind: 'badge', name: `${s.label} badge`, set: s.key, rule: 'playset', description: `Own a full ${s.label} playset (2 of each, 1 Legendary).` },
  ]),
];

export const cosmetic = (id: string): Cosmetic | undefined => COSMETICS.find((c) => c.id === id);

/** Whether a milestone is met, given copies owned per card (tradeable + starter + foil) and the lessons finished. */
export function milestoneMet(rule: MilestoneRule, set: string | undefined, owned: (id: number) => number, lessons: readonly string[]): boolean {
  if (rule === 'tutorial') return lessons.includes('basics');
  if (rule === 'lessons') return LESSONS.every((l) => lessons.includes(l.id));
  const cards = COSMETIC_SETS.find((s) => s.key === set)?.cards ?? [];
  if (!cards.length) return false;
  if (rule === 'commons') return cards.filter((c) => c.rarity === 'common').every((c) => owned(c.id) > 0);
  if (rule === 'every') return cards.every((c) => owned(c.id) > 0);
  return cards.every((c) => owned(c.id) >= (c.rarity === 'legendary' ? 1 : 2));
}

export function unlockedCosmetics(owned: (id: number) => number, lessons: readonly string[]): Set<string> {
  return new Set(COSMETICS.filter((c) => milestoneMet(c.rule, c.set, owned, lessons)).map((c) => c.id));
}

/** What a player shows off: one of each kind (null = none / default). */
export interface Equipped { title: string | null; cardBack: string | null; badge: string | null }
export const NO_COSMETICS: Equipped = { title: null, cardBack: null, badge: null };
