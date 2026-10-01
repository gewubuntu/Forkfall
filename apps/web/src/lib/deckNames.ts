import type { Race } from '@forkfall/engine';
import { RACE_INFO } from '../game/meta.ts';

/** Deck names are a local convenience: the chain stores only the card list. */
const KEY = 'forkfall.deckNames.v1';

function all(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; }
}

export function deckName(id: string, race: Race): string {
  return all()[id.toLowerCase()] ?? `${RACE_INFO[race].name} deck ${id.slice(2, 6).toUpperCase()}`;
}

export function setDeckName(id: string, name: string) {
  try {
    const m = all();
    if (name.trim()) m[id.toLowerCase()] = name.trim().slice(0, 40); else delete m[id.toLowerCase()];
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch { /* storage blocked */ }
}
