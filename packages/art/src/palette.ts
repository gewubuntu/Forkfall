import type { Faction } from '@forkfall/engine';

/** A 3-step shading ramp: [shadow, base, highlight] (style guide: 3 shading steps per color). */
export type Ramp = readonly [string, string, string];

export interface RacePalette {
  /** Four ramps = 12 colors per race (style guide). */
  a: Ramp; b: Ramp; c: Ramp; d: Ramp;
  /** 1 px outline in the race's darkest shade. */
  outline: string;
  /** Flat (unshaded) pixels: glowing bits, eye whites, pupils. */
  glow: string; eye: string; pupil: string;
  /** Frame tint: deep backdrop and the race accent used by the card frame. */
  backdrop: [string, string];
  accent: string;
}

/**
 * Race palettes from the art direction: Agents electric cyan + chrome, Prophets indigo + gold,
 * Brokers emerald + brass, Degens hot pink + lime. 12 ramp colors + 4 flat colors = 16 per sprite at most.
 */
export const PALETTES: Record<Faction, RacePalette> = {
  agents: {
    a: ['#5b6b80', '#94a3b8', '#e2e8f0'], // chrome
    b: ['#0e7490', '#06b6d4', '#67e8f9'], // electric cyan
    c: ['#1e293b', '#334155', '#475569'], // dark steel
    d: ['#115e59', '#14b8a6', '#5eead4'], // teal circuit
    outline: '#0a1220', glow: '#a5f3fc', eye: '#ffffff', pupil: '#0a1220',
    backdrop: ['#082f3a', '#04121a'], accent: '#22d3ee',
  },
  prophets: {
    a: ['#312e81', '#4338ca', '#6366f1'], // indigo robe
    b: ['#a16207', '#eab308', '#fde68a'], // gold
    c: ['#140f33', '#1e1b4b', '#2e2a6b'], // deep night
    d: ['#6d28d9', '#8b5cf6', '#c4b5fd'], // mystic violet
    outline: '#0b0820', glow: '#fde68a', eye: '#fff7d6', pupil: '#140f33',
    backdrop: ['#1e1b4b', '#0b0820'], accent: '#8b7cff',
  },
  brokers: {
    a: ['#065f46', '#047857', '#10b981'], // emerald suit
    b: ['#7c5a14', '#c9a24a', '#f0d78a'], // brass
    c: ['#111827', '#1f2937', '#4b5563'], // charcoal
    d: ['#b8875f', '#e0b48a', '#f6dfc6'], // skin / paper
    outline: '#03120b', glow: '#fef3c7', eye: '#ffffff', pupil: '#111827',
    backdrop: ['#063524', '#03120b'], accent: '#22c55e',
  },
  degens: {
    a: ['#9d174d', '#ec4899', '#f9a8d4'], // hot pink
    b: ['#4d7c0f', '#84cc16', '#d9f99d'], // lime
    c: ['#6b21a8', '#a855f7', '#e9d5ff'], // purple
    d: ['#9a3412', '#f97316', '#fed7aa'], // sticker orange
    outline: '#2a0a1f', glow: '#fef08a', eye: '#ffffff', pupil: '#1a0614',
    backdrop: ['#3b0a2a', '#14030e'], accent: '#ff4fa8',
  },
  neutral: {
    a: ['#4b5563', '#6b7280', '#9ca3af'], // steel
    b: ['#9ca3af', '#d1d5db', '#f3f4f6'], // light stone
    c: ['#111827', '#1f2937', '#374151'], // dark
    d: ['#92400e', '#d97706', '#fbbf24'], // amber
    outline: '#0b0d12', glow: '#fde68a', eye: '#ffffff', pupil: '#0b0d12',
    backdrop: ['#1f2430', '#0b0d12'], accent: '#9aa3b5',
  },
};
