import { CARDS } from './cards.ts';
import { RULES_FINGERPRINT, RULES_HISTORY, RULES_SINCE, RULES_VERSION, type CardPatch } from './rules-history.ts';
import { keccakHex } from './rng.ts';
import type { CardDef } from './types.ts';

/**
 * Rules versions. Every match is played under one version of the card table, recorded in its state and its log,
 * so a match keeps replaying the way it was played after cards are rebalanced. The live table (`CARDS`) is the
 * current version; older ones are rebuilt from `RULES_HISTORY`, which stores only what changed.
 * Changing a card's rules (cost, stats, keywords, effects, targeting) needs a new version: `pnpm rules:bump`.
 * A change to the engine's own logic must be gated on `g.rules` by hand.
 */
export { RULES_SINCE, RULES_VERSION };
export type { CardPatch };

/** Fields that only change how a card looks, not how it plays: editing them needs no new version. */
const DISPLAY_FIELDS = new Set<string>(['text', 'name', 'slug']);

const tables = new Map<number, Map<number, CardDef>>([[RULES_VERSION, new Map(CARDS.map((c) => [c.id, c]))]]);

export function isRulesVersion(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= RULES_VERSION;
}

/** The card table of a rules version, by id. */
export function cardsFor(rules: number): Map<number, CardDef> {
  if (!isRulesVersion(rules)) throw new Error(`unknown rules version ${rules}`);
  let t = tables.get(rules);
  if (t) return t;
  t = new Map(cardsFor(rules + 1));
  for (const [id, patch] of Object.entries(RULES_HISTORY[rules] ?? {})) {
    const next = t.get(Number(id));
    if (patch === null) { t.delete(Number(id)); continue; }
    const c = { ...next, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(patch)) if ((patch as Record<string, unknown>)[k] === null) delete c[k];
    t.set(Number(id), c as unknown as CardDef);
  }
  tables.set(rules, t);
  return t;
}

/** A card as it plays under a rules version. */
export function cardIn(rules: number, id: number): CardDef {
  const c = cardsFor(rules).get(id);
  if (!c) throw new Error(`unknown card ${id} in rules v${rules}`);
  return c;
}

/**
 * The order to try versions in for a match that doesn't record its own (played before versions were recorded).
 * Several versions can replay the same moves to the same result, so the time it was created decides first: the
 * version live then, then older ones (a referee can run behind main), then newer ones. Without a time: newest first.
 */
export function rulesCandidates(createdAt?: number): number[] {
  const all = Array.from({ length: RULES_VERSION }, (_, i) => RULES_VERSION - i);
  if (!createdAt) return all;
  const live = all.find((v) => (RULES_SINCE[v] ?? 0) <= createdAt) ?? 1;
  return [...all.filter((v) => v <= live), ...all.filter((v) => v > live).reverse()];
}

const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
  : v);

/** The fields of a card that decide how it plays, in a stable form. */
function rulesOf(c: CardDef): Record<string, unknown> {
  return Object.fromEntries(Object.entries(sorted(c) as Record<string, unknown>).filter(([k]) => !DISPLAY_FIELDS.has(k)));
}

/** Hash of how every card plays. Pinned per version: a change without `pnpm rules:bump` fails the tests. */
export function rulesFingerprint(cards: readonly CardDef[]): string {
  return keccakHex(JSON.stringify([...cards].sort((a, b) => a.id - b.id).map(rulesOf)));
}

export function currentRulesPinned(): boolean {
  return RULES_FINGERPRINT === rulesFingerprint(CARDS);
}

/**
 * How `older` differs from `newer`, as patches on `newer`: changed fields with their old values (null = the field
 * was absent), and null for a card that didn't exist yet. Display fields are included so old text stays accurate.
 */
export function cardPatches(older: readonly CardDef[], newer: readonly CardDef[]): Record<number, CardPatch> {
  const old = new Map(older.map((c) => [c.id, c]));
  const out: Record<number, CardPatch> = {};
  for (const n of [...newer].sort((a, b) => a.id - b.id)) {
    const o = old.get(n.id);
    if (!o) { out[n.id] = null; continue; }
    const p: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) {
      const ov = (o as unknown as Record<string, unknown>)[k], nv = (n as unknown as Record<string, unknown>)[k];
      if (JSON.stringify(sorted(ov)) !== JSON.stringify(sorted(nv))) p[k] = ov === undefined ? null : ov;
    }
    if (Object.keys(p).length) out[n.id] = p as CardPatch;
  }
  for (const o of older) if (!newer.some((n) => n.id === o.id)) throw new Error(`card ${o.id} was removed: card ids are never reused or removed`);
  return out;
}
