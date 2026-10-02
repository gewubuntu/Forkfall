import { card, SET_NAME, setOf, type CardDef, type Rarity } from '@forkfall/engine';
import { paletteFor } from './palette.ts';
import { spritePixels, spriteRects, SPRITE_SIZE, toBase64 } from './sprite.ts';

/**
 * Full card image: the GDD's "one flat, modern frame shared by all cards, tinted per race", with
 * rarity in the frame material (stone, silver, gold, animated for Legendary) and a corner badge for
 * the chain of origin (text only: no real logos). Pure SVG, so it can live on-chain or in metadata.
 */
export const CARD_W = 500;
export const CARD_H = 700;

const FONT = `Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;
const RACE_NAME = { agents: 'Agents', prophets: 'Prophets', brokers: 'Brokers', degens: 'Degens', neutral: 'Neutral' } as const;
const RARITY_NAME: Record<Rarity, string> = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', legendary: 'Legendary' };

export const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!);

/** Greedy word wrap by an average glyph width (no font metrics in pure SVG). */
export function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s*\S*$/, '') + '…';
    return kept;
  }
  return lines;
}

function material(r: Rarity, id: string): string {
  switch (r) {
    case 'common': // stone: flat grey with a speckle texture
      return `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7a7f8c"/><stop offset="1" stop-color="#3d424e"/></linearGradient>
<pattern id="${id}-tex" width="14" height="14" patternUnits="userSpaceOnUse"><rect width="14" height="14" fill="url(#${id})"/><rect x="2" y="3" width="2" height="2" fill="#9aa0ad" opacity=".5"/><rect x="9" y="8" width="2" height="2" fill="#2c303a" opacity=".5"/><rect x="11" y="1" width="1" height="1" fill="#b4b9c4" opacity=".6"/></pattern>`;
    case 'uncommon': // silver
      return `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f8fafc"/><stop offset=".35" stop-color="#94a3b8"/><stop offset=".6" stop-color="#e2e8f0"/><stop offset="1" stop-color="#64748b"/></linearGradient>`;
    case 'rare': // gold
      return `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fef3c7"/><stop offset=".3" stop-color="#d4a017"/><stop offset=".6" stop-color="#fcd34d"/><stop offset="1" stop-color="#8a5a0b"/></linearGradient>`;
    case 'legendary': // animated: a prismatic sheen sweeping across the gold
      return `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">
<stop offset="0" stop-color="#fde68a"/><stop offset=".25" stop-color="#f472b6"/><stop offset=".5" stop-color="#67e8f9"/><stop offset=".75" stop-color="#a3e635"/><stop offset="1" stop-color="#fbbf24"/>
<animateTransform attributeName="gradientTransform" type="rotate" values="0 .5 .5;360 .5 .5" dur="6s" repeatCount="indefinite"/></linearGradient>`;
  }
}

export interface CardSvgOptions {
  /** Soulbound starter-deck copy (token id = STARTER_OFFSET + base id). */
  starter?: boolean;
}

export function cardSvg(cardId: number, opts: CardSvgOptions = {}): string {
  const c: CardDef = card(cardId);
  const pal = paletteFor(c);
  const collab = setOf(c) !== 'core';
  const m = `mat-${c.rarity}`;
  const frameFill = c.rarity === 'common' ? `url(#${m}-tex)` : `url(#${m})`;
  const scale = 10; // integer scaling only (style guide)
  const art = SPRITE_SIZE * scale;
  const artX = (CARD_W - art) / 2, artY = 70;

  const nameSize = Math.min(32, Math.floor(420 / Math.max(8, c.name.length * 0.56)));
  const rules = wrap(c.text || ' ', 34, 4);
  const chain = c.chain === 'base' ? { label: 'BASE', fill: '#1d4ed8', ink: '#dbeafe' } : c.chain === 'robinhood' ? { label: 'RH', fill: '#15803d', ink: '#dcfce7' } : null;
  const typeLine = `${c.type[0].toUpperCase()}${c.type.slice(1)} · ${collab ? `${SET_NAME[setOf(c)]} set` : RACE_NAME[c.faction]} · ${RARITY_NAME[c.rarity]}`;

  const stat = (x: number, value: number, fill: string, label: string) =>
    `<g><circle cx="${x}" cy="636" r="38" fill="${fill}" stroke="#0b0d12" stroke-width="5"/><text x="${x}" y="651" font-family="${FONT}" font-size="44" font-weight="800" fill="#ffffff" text-anchor="middle" aria-label="${label}">${value}</text></g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_W} ${CARD_H}" width="${CARD_W}" height="${CARD_H}" role="img" aria-label="${esc(c.name)}">
<defs>${material(c.rarity, m)}
<linearGradient id="bd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${pal.backdrop[0]}"/><stop offset="1" stop-color="${pal.backdrop[1]}"/></linearGradient>
<radialGradient id="art" cx=".5" cy=".42" r=".7"><stop offset="0" stop-color="${pal.accent}" stop-opacity=".38"/><stop offset=".6" stop-color="${pal.backdrop[0]}"/><stop offset="1" stop-color="${pal.backdrop[1]}"/></radialGradient>
</defs>
<rect width="${CARD_W}" height="${CARD_H}" rx="30" fill="${frameFill}"/>
<rect x="14" y="14" width="${CARD_W - 28}" height="${CARD_H - 28}" rx="20" fill="url(#bd)" stroke="${pal.accent}" stroke-opacity=".55" stroke-width="2"/>
<rect x="${artX - 30}" y="${artY - 6}" width="${art + 60}" height="${art + 12}" rx="14" fill="url(#art)" stroke="#000" stroke-opacity=".35" stroke-width="2"/>
<svg x="${artX}" y="${artY}" width="${art}" height="${art}" viewBox="0 0 ${SPRITE_SIZE} ${SPRITE_SIZE}" shape-rendering="crispEdges">${spriteRects(spritePixels(cardId))}</svg>
${collab ? serape(artX - 30, artY - 6, art + 60, art + 12) : ''}
${opts.starter ? `<g><rect x="${artX - 30}" y="${artY + art - 12}" width="${art + 60}" height="26" fill="#0b0d12" fill-opacity=".85"/><text x="${CARD_W / 2}" y="${artY + art + 7}" font-family="${FONT}" font-size="16" font-weight="800" letter-spacing="3" fill="#e2e8f0" text-anchor="middle">STARTER · SOULBOUND</text></g>` : ''}
<g><circle cx="62" cy="62" r="40" fill="#0b1a33" stroke="${pal.accent}" stroke-width="5"/><text x="62" y="78" font-family="${FONT}" font-size="46" font-weight="800" fill="#ffffff" text-anchor="middle">${c.cost}</text></g>
${chain ? `<g><rect x="${CARD_W - 132}" y="36" width="96" height="40" rx="20" fill="${chain.fill}" stroke="#0b0d12" stroke-width="3"/><text x="${CARD_W - 84}" y="64" font-family="${FONT}" font-size="20" font-weight="800" letter-spacing="2" fill="${chain.ink}" text-anchor="middle">${chain.label}</text></g>` : ''}
<rect x="34" y="${artY + art + 16}" width="${CARD_W - 68}" height="54" rx="10" fill="#000" fill-opacity=".42"/>
<text x="${CARD_W / 2}" y="${artY + art + 53}" font-family="${FONT}" font-size="${nameSize}" font-weight="800" fill="#ffffff" text-anchor="middle">${esc(c.name)}</text>
${collab ? `<rect x="34" y="${artY + art + 72}" width="${CARD_W - 68}" height="${CARD_H - artY - art - 72 - 86}" rx="10" fill="#2a1206" fill-opacity=".72"/>` : ''}
<text x="${CARD_W / 2}" y="${artY + art + 92}" font-family="${FONT}" font-size="17" font-weight="700" letter-spacing="1" fill="${pal.accent}" text-anchor="middle">${esc(typeLine.toUpperCase())}</text>
<g font-family="${FONT}" font-size="21" fill="#e5e7eb" text-anchor="middle">${rules.map((l, i) => `<text x="${CARD_W / 2}" y="${artY + art + 124 + i * 26}">${esc(l)}</text>`).join('')}</g>
${c.type === 'unit' ? stat(76, c.attack ?? 0, '#d97706', 'attack') + stat(CARD_W - 76, c.health ?? 0, '#dc2626', 'health') : ''}
<text x="${CARD_W / 2}" y="${CARD_H - 32}" font-family="${FONT}" font-size="14" fill="#9ca3af" fill-opacity=".8" text-anchor="middle">#${cardId}${opts.starter ? ' · starter' : ''} · ${collab ? `${SET_NAME[setOf(c)]} collab set` : 'Set 1'} · prototype art</text>
</svg>`;
}

/** Poncho set: red, white and blue poncho stripes along the top and bottom of the art window. */
function serape(x: number, y: number, w: number, h: number): string {
  const colors = ['#e63946', '#fff8ee', '#2d5be3', '#fff8ee', '#e63946', '#1b3a9e'];
  const row = (yy: number) => colors.map((col, i) => `<rect x="${x}" y="${yy + i * 4}" width="${w}" height="4" fill="${col}"/>`).join('');
  return `<g opacity=".95">${row(y)}${row(y + h - 24)}</g>`;
}

export function cardDataUri(cardId: number, opts: CardSvgOptions = {}): string {
  return `data:image/svg+xml;base64,${toBase64(cardSvg(cardId, opts))}`;
}
