import { card, type Faction } from '@forkfall/engine';

/**
 * Prototype placeholder art: a deterministic, mirrored pixel sprite per card in the race palette.
 * Stands in for the commissioned 96x96 pixel art from the style guide; stays crisp at any integer scale.
 */
const PALETTES: Record<Faction, string[]> = {
  agents: ['#0b3a44', '#22d3ee', '#a5f3fc', '#cbd5e1'],
  prophets: ['#1e1b4b', '#6d5dfc', '#f5c451', '#c7c2ff'],
  brokers: ['#052e1a', '#16a34a', '#c9a24a', '#bbf7d0'],
  degens: ['#3b0a2a', '#ff4fa8', '#b6f23c', '#ffffff'],
  neutral: ['#1f2430', '#8390a8', '#cfd6e4', '#5d6679'],
};

const cache = new Map<number, string>();

function rng(seed: number) {
  let s = seed * 2654435761 >>> 0;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

export function spriteSvg(cardId: number): string {
  const hit = cache.get(cardId);
  if (hit) return hit;
  const c = card(cardId);
  const pal = PALETTES[c.faction];
  const N = 12;
  const r = rng(cardId + 7);
  const cells: string[] = [];
  const grid: number[][] = Array.from({ length: N }, () => Array(N).fill(0));
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N / 2; x++) {
      const dx = N / 2 - x, dy = Math.abs(y - N / 2);
      const p = 0.75 - (dx + dy) * 0.07;
      if (r() < p) grid[y][x] = grid[y][N - 1 - x] = 1 + Math.floor(r() * 3);
    }
  }
  // eyes
  const ey = 3 + Math.floor(r() * 3);
  grid[ey][4] = grid[ey][N - 5] = 4;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = grid[y][x];
      if (!v) continue;
      const fill = v === 4 ? (c.faction === 'prophets' ? pal[2] : '#ffffff') : pal[v - 1];
      cells.push(`<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${fill}"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" shape-rendering="crispEdges">${cells.join('')}</svg>`;
  const url = `data:image/svg+xml;base64,${btoa(svg)}`;
  cache.set(cardId, url);
  return url;
}
