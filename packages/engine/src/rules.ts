import { CARDS } from './cards.ts';
import { RULES_FINGERPRINT, RULES_HISTORY, RULES_VERSION, type CardPatch } from './rules-history.ts';
import { keccakHex } from './rng.ts';
import type { CardDef } from './types.ts';

/**
 * Rules versions. Every match is played under one version of the card table, recorded in its state and its log,
 * so a match keeps replaying the way it was played after cards are rebalanced. The live table (`CARDS`) is the
 * current version; older ones are rebuilt from `RULES_HISTORY`, which stores only what changed.
 * Changing a card's rules (cost, stats, keywords, effects, targeting) needs a new version: `pnpm rules:bump`.
 * A change to the engine's own logic must be gated on `g.rules` by hand.
 */
export { RULES_VERSION };

/**
 * The newest version a referee could run before matches recorded their version: every log or saved match without
 * one was played under this or an older one. (v4 shipped together with recording.)
 */
export const LAST_UNRECORDED_RULES = 3;

/** When each unrecorded-era version went live: its merge into main (ms). */
export const UNRECORDED_RULES_SINCE: Record<number, number> = {
  1: 0,
  2: 1791195289000, // #32, 2026-10-05T10:14:49Z
  3: 1791203805000, // #33, 2026-10-05T12:36:45Z
};
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
 * The order to try versions in for a match that doesn't record its own (played before versions were recorded, so
 * under v1–LAST_UNRECORDED_RULES). Several versions can replay the same moves to the same result, so the time it was
 * created decides first: the version live then, then older ones (a referee can run behind main), then newer ones of
 * that era. Versions after it come last, only in case a referee ran one without recording it.
 */
export function rulesCandidates(createdAt?: number): number[] {
  const era = Array.from({ length: LAST_UNRECORDED_RULES }, (_, i) => LAST_UNRECORDED_RULES - i);
  const after = Array.from({ length: RULES_VERSION - LAST_UNRECORDED_RULES }, (_, i) => LAST_UNRECORDED_RULES + 1 + i);
  if (!createdAt) return [...era, ...after];
  const live = era.find((v) => UNRECORDED_RULES_SINCE[v] <= createdAt) ?? 1;
  return [...era.filter((v) => v <= live), ...era.filter((v) => v > live).reverse(), ...after];
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

export type BumpPlan =
  | { action: 'unchanged' }
  | { action: 'revert' }
  | { action: 'bump'; version: number; patchOf: number }
  | { action: 'refuse'; reason: string };

/**
 * What `pnpm rules:bump` does on a branch, given the base ref's version and fingerprint, this branch's pinned ones
 * and the live table's. A branch only ever adds the one version after its base: re-running it redoes that version,
 * and a base that isn't the branch's own (stale, or ahead) is refused, so a version that shipped is never redefined.
 */
export function bumpPlan(base: { version: number; fingerprint: string }, local: { version: number; fingerprint: string }, live: string): BumpPlan {
  if (live === base.fingerprint) return local.version === base.version && local.fingerprint === base.fingerprint ? { action: 'unchanged' } : { action: 'revert' };
  if (live === local.fingerprint && local.version === base.version + 1) return { action: 'unchanged' };
  if (local.version !== base.version && local.version !== base.version + 1) {
    return { action: 'refuse', reason: `the base is at rules v${base.version} and this branch at v${local.version}: fetch and merge the base first` };
  }
  return { action: 'bump', version: base.version + 1, patchOf: base.version };
}
