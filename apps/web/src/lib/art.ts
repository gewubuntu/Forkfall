import { spriteDataUri } from '@forkfall/art';
import type { Faction } from '@forkfall/engine';

/** Avatar palettes per race (card art lives in @forkfall/art). */
const PALETTES: Record<Faction, string[]> = {
  agents: ['#0b3a44', '#22d3ee', '#a5f3fc', '#cbd5e1'],
  prophets: ['#1e1b4b', '#6d5dfc', '#f5c451', '#c7c2ff'],
  brokers: ['#052e1a', '#16a34a', '#c9a24a', '#bbf7d0'],
  degens: ['#3b0a2a', '#ff4fa8', '#b6f23c', '#ffffff'],
  neutral: ['#1f2430', '#8390a8', '#cfd6e4', '#5d6679'],
};

/** Card sprites come from @forkfall/art, the same generator the on-chain metadata uses. */
export const spriteSvg = (cardId: number): string => spriteDataUri(cardId);

function rng(seed: number) {
  let s = seed * 2654435761 >>> 0;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

/** Deterministic pixel avatar for a wallet address (race palette picked from the address). */
export function avatarSvg(address: string): string {
  const key = `a:${address.toLowerCase()}`;
  const hit = avatarCache.get(key);
  if (hit) return hit;
  const seed = parseInt(address.slice(2, 10), 16) || 1;
  const factions: Faction[] = ['agents', 'prophets', 'brokers', 'degens'];
  const pal = PALETTES[factions[seed % 4]];
  const N = 10;
  const r = rng(seed);
  const cells: string[] = [`<rect width="${N}" height="${N}" fill="${pal[0]}"/>`];
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N / 2; x++) {
      if (r() < 0.55) {
        const fill = pal[1 + Math.floor(r() * 3)];
        cells.push(`<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${fill}"/><rect x="${N - 1 - x}" y="${y}" width="1.02" height="1.02" fill="${fill}"/>`);
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" shape-rendering="crispEdges">${cells.join('')}</svg>`;
  const url = `data:image/svg+xml;base64,${btoa(svg)}`;
  avatarCache.set(key, url);
  return url;
}
const avatarCache = new Map<string, string>();

/** Pixel "fork" mark: one stem splitting into a Base (blue) prong and a Robinhood Chain (green) prong. */
export const LOGO_MARK = (() => {
  const px = [
    // [x, y, color]
    ...[2, 3, 4].flatMap((y) => [[2, y, '#38bdf8'], [7, y, '#a3e635']]),
    [2, 5, '#3b82f6'], [3, 6, '#3b82f6'], [7, 5, '#22c55e'], [6, 6, '#22c55e'],
    [4, 7, '#cfe3ff'], [5, 7, '#d9ffc2'], [4, 8, '#ffffff'], [5, 8, '#ffffff'], [4, 9, '#e6e9f2'], [5, 9, '#e6e9f2'],
  ] as [number, number, string][];
  const rects = px.map(([x, y, c]) => `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${c}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 1 10 10" shape-rendering="crispEdges">${rects}</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
})();
