import { card, setOf } from '@forkfall/engine';

/**
 * Poncho collab art in the Poncho Pals style (licensed): flat vector, thick navy outlines, a bust of a chibi cat
 * with a wide head and pointy cheek tufts, a white muzzle with a forehead stripe, big glossy eyes, an "ω" smile
 * with an open mouth, blush, a paw holding an item, a geometric poncho with a V-neck and a PB badge, on a flat
 * background. Each card is its own pal, built from traits. Drawn in a 400×400 box.
 */
export const PONCHO_VIEW = 400;

const INK = '#1e1440';
const SW = 9; // outline width
const olw = (w: number) => `stroke="${INK}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;
const ol = olw(SW);

interface Fur { base: string; dark: string; cheek: string; inner: string }
const FUR: Record<'ginger' | 'grey' | 'tan', Fur> = {
  ginger: { base: '#f0902a', dark: '#c4601a', cheek: '#f7ab4a', inner: '#ffffff' },
  grey: { base: '#9a9da6', dark: '#6f7380', cheek: '#c2c5cc', inner: '#e3242b' },
  tan: { base: '#c99e80', dark: '#8a5e4a', cheek: '#f7c06c', inner: '#ff7a70' },
};
interface PonchoPal { base: string; shade: string; band1: string; band2: string; tri: string }
const PONCHO: Record<'classic' | 'fiesta' | 'night', PonchoPal> = {
  classic: { base: '#2d5be3', shade: '#1d3fae', band1: '#e63946', band2: '#e63946', tri: '#ffffff' },
  fiesta: { base: '#16c49a', shade: '#0e9a78', band1: '#f59e0b', band2: '#ff7a85', tri: '#fff8e6' },
  night: { base: '#55575e', shade: '#3c3e45', band1: '#55575e', band2: '#55575e', tri: '#55575e' },
};

export interface PalTraits {
  bg: string;
  fur: keyof typeof FUR;
  poncho: keyof typeof PONCHO;
  hat?: { kind: 'sombrero'; crown: string; brim: string; zig: string; band: string } | { kind: 'headband'; color: string };
  eyes?: 'happy' | 'sunglasses' | 'laser';
  brows?: boolean;
  item?: 'taco' | 'salsa' | 'mic' | 'cash' | 'none';
  sparkles?: boolean;
  /** Scale and offset, for group scenes. */
  s?: number; dx?: number; dy?: number;
  kitten?: boolean;
}

// ─── Parts ────────────────────────────────────────────────────────────────────
const HEAD = 'M200 112 C268 112 312 150 320 202 L346 236 C320 272 262 284 200 284 C138 284 80 272 54 236 L80 202 C88 150 132 112 200 112 Z';

function sparkles(): string {
  const star = (x: number, y: number, r: number) =>
    `<path d="M${x} ${y - r} Q${x + r * 0.18} ${y - r * 0.18} ${x + r} ${y} Q${x + r * 0.18} ${y + r * 0.18} ${x} ${y + r} Q${x - r * 0.18} ${y + r * 0.18} ${x - r} ${y} Q${x - r * 0.18} ${y - r * 0.18} ${x} ${y - r} Z" fill="#fff"/>`;
  return [star(52, 70, 22), star(352, 58, 16), star(372, 210, 18), star(30, 230, 14), star(330, 330, 20), star(120, 34, 12)].join('')
    + '<circle cx="80" cy="140" r="5" fill="#f59e0b"/><circle cx="340" cy="120" r="5" fill="#16c49a"/><circle cx="356" cy="280" r="5" fill="#f59e0b"/>';
}

function ponchoBody(p: PonchoPal, id: string): string {
  const body = 'M70 410 L128 286 Q200 268 272 286 L330 410 Z';
  const bands = p.band1 === p.base ? '' : `
    <g clip-path="url(#${id}-b)">
      <path d="M60 318 L130 318 L200 350 L270 318 L340 318 L340 344 L270 344 L200 376 L130 344 L60 344 Z" fill="${p.band1}"/>
      ${[100, 140, 180, 220, 260, 300].map((x) => `<path d="M${x - 10} 344 L${x} 324 L${x + 10} 344 Z" fill="${p.tri}"/>`).join('')}
      <path d="M60 360 L140 360 L200 388 L260 360 L340 360 L340 378 L260 378 L200 406 L140 378 L60 378 Z" fill="${p.band2}"/>
      ${[110, 170, 230, 290].map((x) => `<path d="M${x} 392 L${x + 14} 402 L${x} 412 Z" fill="${p.tri}"/>`).join('')}
      ${[150, 250].map((x) => `<path d="M${x - 9} 384 L${x} 366 L${x + 9} 384 Z" fill="${p.tri}"/>`).join('')}
    </g>`;
  return `<clipPath id="${id}-b"><path d="${body}"/></clipPath>
    <path d="${body}" fill="${p.base}"/>${bands}
    <path d="M150 288 L200 318 L250 288 Z" fill="${p.shade}"/>
    <path d="M150 288 L200 312 L250 288" fill="#e86a7a" opacity=".55"/>
    <path d="${body}" fill="none" ${ol}/>
    <path d="M292 330 L312 380" ${ol} fill="none"/>`;
}

function badge(): string {
  return `<g transform="translate(252 296) rotate(-2)">
    <rect width="54" height="40" rx="10" fill="#fbbf24" ${ol}/>
    <rect x="7" y="6" width="40" height="28" rx="6" fill="#fff4cc"/>
    <text x="27" y="29" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="22" fill="#e0a010" text-anchor="middle">PB</text>
  </g>`;
}

function ears(f: Fur): string {
  return `<path d="M88 190 L104 74 Q112 64 122 72 L182 120 Z" fill="${f.base}" ${ol}/>
    <path d="M312 190 L296 74 Q288 64 278 72 L218 120 Z" fill="${f.base}" ${ol}/>
    <path d="M104 160 L114 92 L160 126 Z" fill="${f.inner}"/>
    <path d="M296 160 L286 92 L240 126 Z" fill="${f.inner}"/>`;
}

function face(f: Fur, t: PalTraits, id: string): string {
  const eyes = t.eyes ?? 'happy';
  const parts: string[] = [];
  parts.push(`<clipPath id="${id}-h"><path d="${HEAD}"/></clipPath><path d="${HEAD}" fill="${f.base}"/>`);
  parts.push(`<g clip-path="url(#${id}-h)">
      <path d="M40 120 Q200 60 360 120 L360 168 Q200 128 40 168 Z" fill="${f.dark}" opacity=".85"/>
      <ellipse cx="146" cy="214" rx="66" ry="52" fill="${f.cheek}"/>
      <ellipse cx="254" cy="214" rx="66" ry="52" fill="${f.cheek}"/>
      <path d="M200 140 L186 206 C160 236 96 244 50 240 L50 300 L350 300 L350 240 C304 244 240 236 214 206 Z" fill="#fbf7ec"/>
    </g>`);
  parts.push(`<path d="${HEAD}" fill="none" ${ol}/>`);
  if (t.brows) parts.push(`<path d="M128 168 Q146 160 164 166" ${ol} fill="none"/><path d="M236 166 Q254 160 272 168" ${ol} fill="none"/>`);
  if (eyes === 'happy') {
    const r = t.kitten ? 31 : 27;
    for (const x of [148, 252]) {
      parts.push(`<circle cx="${x}" cy="208" r="${r}" fill="${INK}"/><circle cx="${x + 8}" cy="198" r="${r * 0.32}" fill="#fff"/><circle cx="${x + 17}" cy="210" r="${r * 0.14}" fill="#fff"/>`);
    }
  } else if (eyes === 'sunglasses') {
    parts.push(`<path d="M78 200 L118 202 M282 202 L322 200 M176 204 Q200 194 224 204" ${olw(6)} fill="none"/>`);
    for (const x of [146, 254]) {
      parts.push(`<circle cx="${x}" cy="208" r="32" fill="#231a4d" ${olw(6)}/><path d="M${x - 18} ${208 + 6} L${x + 4} ${208 - 18} M${x - 8} ${208 + 16} L${x + 16} ${208 - 8}" stroke="#7d8fd6" stroke-width="6" stroke-linecap="round"/>`);
    }
  } else {
    for (const x of [150, 250]) parts.push(`<circle cx="${x}" cy="210" r="24" fill="#fff" ${olw(6)}/><circle cx="${x}" cy="210" r="7" fill="#e3242b"/>`);
  }
  // Nose, mouth, blush.
  parts.push(`<path d="M190 232 Q200 226 210 232 Q206 244 200 246 Q194 244 190 232 Z" fill="${INK}"/>`);
  if (eyes === 'laser') parts.push(`<rect x="184" y="254" width="32" height="12" rx="3" fill="${INK}"/><path d="M190 260 L210 260" stroke="#fbbf24" stroke-width="4" stroke-dasharray="3 2"/>`);
  else parts.push(`<path d="M174 250 Q187 262 200 250 Q213 262 226 250" ${olw(6)} fill="none"/>
    <path d="M188 258 Q200 286 212 258 Q200 264 188 258 Z" fill="#e3242b" ${olw(5)}/><path d="M193 270 Q200 280 207 270 Z" fill="#ff8a8a"/>`);
  parts.push(`<rect x="88" y="236" width="30" height="16" rx="8" fill="#e3242b" opacity=".85"/>`);
  parts.push(`<rect x="282" y="236" width="30" height="16" rx="8" fill="${eyes === 'sunglasses' ? '#fff' : '#8a5e4a'}" opacity=".85"/>`);
  return parts.join('');
}

const BRIM = 'M20 160 Q200 64 380 160 Q370 190 340 192 Q200 150 60 192 Q30 190 20 160 Z';

function hat(t: PalTraits, id: string): string {
  const h = t.hat;
  if (!h) return '';
  if (h.kind === 'headband') {
    return `<path d="M76 160 Q200 116 324 160 L322 186 Q200 146 78 186 Z" fill="${h.color}" ${ol}/>
      <path d="M86 168 L36 150 L44 178 L28 196 L84 186" fill="${h.color}" ${ol}/>`;
  }
  // The zigzag band follows the brim's lower edge, spikes pointing up into the brim.
  const edge = (x: number) => 171 + ((x - 200) ** 2) * (21 / 140 ** 2);
  const pts: string[] = [];
  for (let x = 30; x <= 370; x += 20) pts.push(`${x},${(edge(x) - ((x / 20) % 2 ? 36 : 14)).toFixed(1)}`);
  const bottom = [370, 300, 200, 100, 30].map((x) => `${x},${(edge(x) + 30).toFixed(1)}`);
  return `<path d="M144 112 Q144 50 200 46 Q256 50 256 112 Z" fill="${h.crown}" ${ol}/>
    <path d="M147 86 Q200 74 253 86 L255 100 Q200 88 145 100 Z" fill="${h.band}"/>
    <path d="${BRIM}" fill="${h.brim}"/>
    <polygon points="${pts.join(' ')} ${bottom.join(' ')}" fill="${h.zig}" clip-path="url(#${id}-brim)"/>
    <path d="${BRIM}" fill="none" ${ol}/>`;
}

function paw(f: Fur, item: PalTraits['item']): string {
  const itemSvg = {
    taco: `<g transform="translate(96 272) rotate(-62) scale(.62)">${tacoShape()}</g>`,
    salsa: `<g transform="translate(62 230) rotate(-12)">
        <rect x="10" y="0" width="22" height="24" rx="4" fill="#fbbf24" ${ol}/>
        <path d="M4 26 L38 26 L44 110 Q22 118 -2 110 Z" fill="#e3242b" ${ol}/>
        <rect x="6" y="56" width="32" height="26" fill="#fff4cc"/><path d="M14 70 Q22 60 30 70 Q22 78 14 70 Z" fill="#7ed957"/>
      </g>`,
    mic: `<g transform="translate(70 232) rotate(-10)">
        <rect x="22" y="70" width="16" height="70" rx="8" fill="#7ea7d8" ${ol}/>
        <ellipse cx="30" cy="40" rx="34" ry="40" fill="#cfe0f5" ${ol}/>
        ${[22, 36, 50].map((y) => `<path d="M2 ${y} Q30 ${y + 8} 58 ${y}" stroke="${INK}" stroke-width="5" fill="none"/>`).join('')}
      </g>`,
    cash: `<g transform="translate(46 262) rotate(-18)">
        <rect x="8" y="-8" width="96" height="54" rx="4" fill="#3fae49" ${ol}/>
        <rect x="0" y="4" width="96" height="54" rx="4" fill="#5cd65c" ${ol}/>
        <circle cx="48" cy="31" r="14" fill="#3fae49"/><text x="48" y="39" font-family="Arial Black, Arial" font-size="20" fill="#e8ffe8" text-anchor="middle">$</text>
      </g>`,
    none: '',
  }[item ?? 'none'];
  if (!item || item === 'none') return '';
  return `${itemSvg}<path d="M70 352 Q60 300 98 296 Q130 296 128 336 Q124 360 92 362 Q76 362 70 352 Z" fill="${f.base}" ${ol}/>
    <path d="M86 318 Q100 324 118 318 M84 336 Q100 342 120 336" stroke="${INK}" stroke-width="5" fill="none" stroke-linecap="round"/>
    <path d="M88 304 Q104 300 116 308" stroke="#fff" stroke-width="7" fill="none" stroke-linecap="round" opacity=".9"/>`;
}

/** One pal (bust) as SVG elements in the 400×400 box. */
export function palSvg(t: PalTraits, id = 'pal'): string {
  const f = FUR[t.fur];
  const lasers = t.eyes === 'laser'
    ? `<defs><linearGradient id="${id}-l" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff2a2a" stop-opacity=".9"/><stop offset="1" stop-color="#ff2a2a" stop-opacity=".15"/></linearGradient></defs>
       <path d="M144 214 L120 400 L170 400 L156 214 Z M244 214 L230 400 L280 400 L256 214 Z" fill="url(#${id}-l)"/>`
    : '';
  const brimClip = `<clipPath id="${id}-brim"><path d="${BRIM}"/></clipPath>`;
  const group = `${brimClip}${ponchoBody(PONCHO[t.poncho], id)}${badge()}${ears(f)}${face(f, t, id)}${hat(t, id)}${lasers}${paw(f, t.item)}`;
  const s = t.s ?? 1;
  return `<g transform="translate(${t.dx ?? 0} ${t.dy ?? 0}) scale(${s})">${group}</g>`;
}

/** Side-view taco in its own 200-wide box centred on 0,0: lettuce and tomato poke out of the open top. */
function tacoShape(): string {
  const lettuce = Array.from({ length: 9 }, (_, k) => { const x = -84 + k * 21; return `Q${x + 10} ${-44 - (k % 2) * 10} ${x + 21} -22`; }).join(' ');
  return `<path d="M-90 -14 Q-88 -40 -84 -22 ${lettuce} L96 -10 Z" fill="#7ed957" ${olw(7)}/>
    ${[-62, -24, 14, 52].map((cx, k) => `<circle cx="${cx}" cy="${-30 - (k % 2) * 6}" r="12" fill="#e3242b" ${olw(5)}/>`).join('')}
    <path d="M-80 -30 L80 -30" stroke="#8a4b20" stroke-width="10" stroke-linecap="round"/>
    <path d="M-98 -12 Q-90 92 0 96 Q90 92 98 -12 Q0 6 -98 -12 Z" fill="#f2b33d" ${ol}/>
    <path d="M-84 6 Q0 22 84 6" stroke="#ffd98a" stroke-width="7" fill="none" stroke-linecap="round"/>
    ${[[-56, 34], [-20, 52], [18, 40], [52, 30], [-34, 72], [6, 76], [44, 62]].map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="6" fill="#c97a1a"/>`).join('')}`;
}

function taco(x: number, y: number, s: number, rot: number): string {
  return `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s})">${tacoShape()}</g>`;
}

function truck(): string {
  return `<rect x="0" y="0" width="400" height="400" fill="#ffb347"/>
    <rect x="0" y="300" width="400" height="100" fill="#f08a2c"/>
    <path d="M40 140 L280 140 L280 300 L40 300 Z" fill="#2d5be3" ${ol}/>
    <path d="M280 190 L340 190 L370 240 L370 300 L280 300 Z" fill="#2d5be3" ${ol}/>
    <path d="M292 202 L334 202 L356 240 L292 240 Z" fill="#cfe0f5" ${ol}/>
    <rect x="64" y="168" width="180" height="90" rx="6" fill="#1e1440"/>
    ${Array.from({ length: 6 }, (_, i) => `<path d="M${40 + i * 40} 140 L${80 + i * 40} 140 L${80 + i * 40} 160 Q${60 + i * 40} 176 ${40 + i * 40} 160 Z" fill="${i % 2 ? '#fff' : '#e3242b'}" ${olw(6)}/>`).join('')}
    <clipPath id="truckwin"><rect x="64" y="168" width="180" height="90" rx="6"/></clipPath>
    <g clip-path="url(#truckwin)">${palSvg({ bg: '', fur: 'ginger', poncho: 'classic', item: 'none', s: 0.42, dx: 70, dy: 142 }, 'truckpal')}</g>
    <rect x="40" y="252" width="240" height="48" fill="#2d5be3"/>
    <path d="M40 252 L280 252" ${ol}/><path d="M40 140 L280 140 L280 300 L40 300 Z" fill="none" ${ol}/>
    <text x="160" y="286" font-family="Arial Black, Arial" font-size="26" fill="#fbbf24" text-anchor="middle">TACOS</text>
    ${[100, 320].map((cx) => `<circle cx="${cx}" cy="306" r="30" fill="#2b2b33" ${ol}/><circle cx="${cx}" cy="306" r="11" fill="#cfd3dc"/>`).join('')}
    ${taco(160, 96, 0.55, -6)}`;
}

const SOMBRERO_BLUE = { kind: 'sombrero' as const, crown: '#2d5be3', brim: '#2d5be3', zig: '#e63946', band: '#e63946' };
const SOMBRERO_TEAL = { kind: 'sombrero' as const, crown: '#16c49a', brim: '#16c49a', zig: '#ff7a85', band: '#f59e0b' };

/** The pal for each Poncho card (ids 41–48) and the Taco token (1002). */
export const PONCHO_PALS: Record<number, PalTraits> = {
  41: { bg: '#ff9fb2', fur: 'ginger', poncho: 'fiesta', item: 'taco', kitten: true },
  43: { bg: '#2d5be3', fur: 'ginger', poncho: 'fiesta', hat: { kind: 'headband', color: '#e63946' }, eyes: 'sunglasses', item: 'salsa' },
  44: { bg: '#f4f1ea', fur: 'grey', poncho: 'night', hat: SOMBRERO_TEAL, eyes: 'laser', brows: true, item: 'cash' },
  47: { bg: '#d58cff', fur: 'tan', poncho: 'fiesta', brows: true, item: 'mic', sparkles: true },
  48: { bg: '#f6a93b', fur: 'ginger', poncho: 'classic', hat: SOMBRERO_BLUE, item: 'taco' },
};

export const isPonchoArt = (cardId: number): boolean => {
  try { return setOf(card(cardId)) === 'poncho'; } catch { return false; }
};

/** Inner SVG (no <svg> wrapper) for a Poncho card in the 400×400 box, or null for other cards. */
export function ponchoArt(cardId: number): string | null {
  if (!isPonchoArt(cardId)) return null;
  const id = `p${cardId}`;
  const bg = (c: string) => `<rect width="400" height="400" fill="${c}"/>`;
  switch (cardId) {
    case 42: return `${bg('#ffcf5c')}${sparkles()}${taco(130, 250, 1.15, -12)}${taco(270, 190, 1.15, 10)}`;
    case 1002: return `${bg('#7ed957')}${taco(200, 220, 1.6, -6)}`;
    case 45: return truck();
    case 46: return `${bg('#16c49a')}
      ${palSvg({ bg: '', fur: 'grey', poncho: 'night', hat: SOMBRERO_TEAL, item: 'none', s: 0.62, dx: -30, dy: 30 }, `${id}a`)}
      ${palSvg({ bg: '', fur: 'tan', poncho: 'fiesta', hat: { kind: 'headband', color: '#2d5be3' }, item: 'none', s: 0.62, dx: 182, dy: 30 }, `${id}b`)}
      ${palSvg({ bg: '', fur: 'ginger', poncho: 'classic', hat: SOMBRERO_BLUE, item: 'taco', s: 0.78, dx: 44, dy: 92 }, `${id}c`)}`;
    default: {
      const t = PONCHO_PALS[cardId];
      return `${bg(t.bg)}${t.sparkles ? sparkles() : ''}${palSvg(t, id)}`;
    }
  }
}

/** Standalone SVG for a Poncho card. */
export function ponchoSvg(cardId: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PONCHO_VIEW} ${PONCHO_VIEW}">${ponchoArt(cardId)}</svg>`;
}
