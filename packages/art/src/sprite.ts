import { card, type CardDef } from '@forkfall/engine';
import { paletteFor, type RacePalette } from './palette.ts';

/**
 * Placeholder pixel art that follows the GDD pixel style guide, generated per card:
 * one light from the top left with 3 shades per color, a 1 px outline in the race's darkest shade,
 * at most 16 colors, no background (the frame supplies it), feet on a shared baseline, and the race
 * accents (Agents: metallic glints and sensor dots; Prophets: gold glow; Brokers: tidy and symmetric;
 * Degens: off-model critters with a white sticker outline). Final art is human-made (GDD guardrail);
 * these stand in until commissioned sprites replace them card by card.
 */
export const SPRITE_SIZE = 32;
const N = SPRITE_SIZE;
const BASE = 28; // feet baseline

type Ramp = 'a' | 'b' | 'c' | 'd';
type Mat = Ramp | 'glow' | 'eye' | 'pupil';
const isRamp = (m: Mat | null): m is Ramp => m === 'a' || m === 'b' || m === 'c' || m === 'd';

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  const next = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  return {
    next,
    int: (a: number, b: number) => a + Math.floor(next() * (b - a + 1)),
    pick: <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof rng>;

class Canvas {
  readonly px: (Mat | null)[] = Array(N * N).fill(null);
  /** Extra flat pixels drawn after the outline (glints, sparkles), keyed by index. */
  readonly sparkles = new Set<number>();
  get(x: number, y: number) { return x < 0 || y < 0 || x >= N || y >= N ? null : this.px[y * N + x]; }
  set(x: number, y: number, m: Mat | null) {
    x = Math.round(x); y = Math.round(y);
    if (x >= 1 && y >= 1 && x < N - 1 && y < N - 1) this.px[y * N + x] = m;
  }
  rect(x: number, y: number, w: number, h: number, m: Mat | null) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, m);
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, m: Mat | null) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x + 0.5 - (cx + 0.5)) / (rx + 0.35), dy = (y + 0.5 - (cy + 0.5)) / (ry + 0.35);
        if (dx * dx + dy * dy <= 1) this.set(x, y, m);
      }
    }
  }
  poly(pts: [number, number][], m: Mat | null) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
        const px = x + 0.5, py = y + 0.5;
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i], [xj, yj] = pts[j];
          if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) this.set(x, y, m);
      }
    }
  }
  line(x0: number, y0: number, x1: number, y1: number, m: Mat | null) {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, m);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  /** Mirror the left half onto the right (tidy, symmetric shapes). */
  mirror() {
    for (let y = 0; y < N; y++) for (let x = 0; x < N / 2; x++) this.px[y * N + (N - 1 - x)] = this.px[y * N + x];
  }
  /** Glints and sparkles in empty space at least 2 px from the figure, so they float free of the outline. */
  sparkle(r: Rng, n: number, region: [number, number, number, number] = [2, 2, N - 3, N - 3]) {
    for (let tries = 0; tries < n * 30 && n > 0; tries++) {
      const x = r.int(region[0], region[2]), y = r.int(region[1], region[3]);
      let clear = true;
      for (let j = -2; j <= 2 && clear; j++) for (let i = -2; i <= 2; i++) if (this.get(x + i, y + j)) { clear = false; break; }
      if (clear) { this.sparkles.add(y * N + x); n--; }
    }
  }
}

/** 0 (tiny) … 4 (huge), from Gas cost; Legendaries read big. */
function sizeClass(c: CardDef) {
  const s = c.cost <= 1 ? 0 : c.cost <= 3 ? 1 : c.cost <= 5 ? 2 : c.cost <= 7 ? 3 : 4;
  return c.rarity === 'legendary' ? Math.max(s, 3) : s;
}
const has = (c: CardDef, ...words: string[]) => words.some((w) => c.name.toLowerCase().includes(w));

// ─── Archetypes ───────────────────────────────────────────────────────────────
function robot(cv: Canvas, r: Rng, c: CardDef) {
  const sz = sizeClass(c);
  const headW = 8 + 2 * Math.min(2, Math.floor(sz / 2));
  const headH = 6 + (sz >= 3 ? 1 : 0);
  const bodyW = headW + 2 + (sz >= 2 ? 2 : 0);
  const bodyH = 5 + sz;
  const legH = 3 + (sz >= 2 ? 1 : 0);
  const L = (w: number) => 16 - w / 2;
  const legs = r.pick(['legs', 'treads', 'hover'] as const);
  if (legs === 'legs') {
    cv.rect(L(bodyW) + 1, BASE - legH + 1, 3, legH, 'c');
    cv.rect(L(bodyW), BASE, 4, 1, 'a');
  } else if (legs === 'treads') {
    cv.rect(L(bodyW), BASE - 2, bodyW / 2, 3, 'c');
    cv.set(L(bodyW) + 2, BASE - 1, 'pupil');
  } else {
    cv.rect(L(bodyW) + 3, BASE - legH + 1, 3, 2, 'c');
    cv.rect(L(bodyW) + 3, BASE - legH + 3, 3, 1, 'glow');
  }
  const bodyTop = BASE - legH - bodyH + 1;
  cv.rect(L(bodyW), bodyTop, bodyW / 2, bodyH, 'a');
  cv.rect(L(bodyW) - 2, bodyTop + 1, 2, bodyH - 1 + (sz >= 2 ? 1 : 0), 'c'); // arm
  cv.rect(L(bodyW) - 2, bodyTop + bodyH + (sz >= 2 ? 0 : -1), 2, 2, 'a'); // hand
  cv.rect(14, bodyTop + 1, 2, Math.min(3, bodyH - 2), 'b'); // core
  cv.rect(15, bodyTop - 1, 1, 1, 'c'); // neck
  const headTop = bodyTop - 1 - headH;
  cv.rect(L(headW), headTop, headW / 2, headH, 'a');
  cv.rect(L(headW) + 1, headTop + 2, headW / 2 - 1, 2, 'c'); // visor
  const antennae = r.int(0, 2);
  const ax = L(headW) + 2, ar = N - 1 - ax, aTop = headTop - 2 - (sz >= 3 ? 1 : 0);
  if (antennae >= 1) cv.line(ax, headTop - 1, ax, aTop, 'c');
  cv.mirror();
  if (antennae === 1) cv.line(ar, headTop - 1, ar, aTop, null);
  if (antennae >= 1) cv.set(ax, aTop - 1, 'glow');
  if (antennae === 2) cv.set(ar, aTop - 1, 'glow');
  // Sensor eyes and core light: glowing dots.
  const eyes = r.pick(['dots', 'scanner'] as const);
  if (eyes === 'dots') { cv.set(ax, headTop + 2, 'glow'); cv.set(ar, headTop + 2, 'glow'); }
  else cv.rect(ax, headTop + 2, headW - 4, 1, 'glow');
  cv.rect(15, bodyTop + 2, 2, 1, 'glow');
  if (sz >= 3) for (let i = 0; i < 3; i++) cv.set(13 + i * 3, bodyTop + bodyH - 2, 'glow'); // chest lights
}

function drone(cv: Canvas, r: Rng) {
  const cy = r.int(14, 16);
  cv.ellipse(15.5, cy, 6, 4, 'a');
  cv.rect(10, cy, 12, 1, 'c');
  cv.rect(15, cy - 6, 2, 2, 'c');
  cv.rect(7, cy - 7, 18, 1, 'c');
  cv.ellipse(15.5, cy, 1.5, 1.5, 'b');
  cv.set(15, cy, 'glow'); cv.set(16, cy, 'glow');
  for (let i = 0; i < 3; i++) cv.set(14 + i, cy + 7 + (i % 2), 'glow');
}

function robed(cv: Canvas, r: Rng, c: CardDef, pal: { trim: Ramp; robe: Ramp }) {
  const sz = sizeClass(c);
  const robeH = 10 + sz * 2;
  const sh = BASE - robeH;
  cv.poly([[13, sh], [19, sh], [23 + sz, BASE + 1], [9 - sz, BASE + 1]], pal.robe);
  cv.rect(9 - sz, BASE, 15 + 2 * sz, 1, pal.trim);
  cv.line(16, sh + 3, 16, BASE - 1, pal.trim);
  cv.poly([[16, sh - 10], [21, sh - 3], [20, sh + 1], [12, sh + 1], [11, sh - 3]], pal.robe); // hood
  cv.ellipse(16, sh - 3, 2.5, 2, 'c'); // shadowed face
  cv.set(15, sh - 3, 'glow'); cv.set(17, sh - 3, 'glow');
  cv.rect(19, sh + 3, 4, 3, pal.robe); // sleeve reaching forward (three-quarter, facing right)
  cv.rect(23, sh + 4, 2, 2, 'glow'); // glowing hand
  const prop = r.pick(['staff', 'orb', 'book'] as const);
  if (prop === 'staff') { cv.line(9 - Math.min(sz, 1), sh - 5, 9 - Math.min(sz, 1), BASE, 'b'); cv.ellipse(9 - Math.min(sz, 1), sh - 7, 1.5, 1.5, 'd'); cv.set(9 - Math.min(sz, 1), sh - 7, 'glow'); }
  else if (prop === 'orb') { cv.ellipse(26, sh + 1, 2, 2, 'd'); cv.set(26, sh, 'glow'); }
  else { cv.rect(8, sh + 5, 5, 4, 'b'); cv.line(10, sh + 5, 10, sh + 8, 'c'); }
}

function bigEye(cv: Canvas) {
  cv.poly([[3, 15], [9, 9], [16, 7], [23, 9], [29, 15], [23, 21], [16, 23], [9, 21]], 'b');
  cv.ellipse(16, 15, 9, 5, 'eye');
  cv.ellipse(16, 15, 4, 4, 'd');
  cv.ellipse(16, 15, 2, 2, 'pupil');
  cv.set(14, 13, 'glow'); cv.set(15, 13, 'glow');
}

function suit(cv: Canvas, r: Rng, c: CardDef) {
  const sz = sizeClass(c);
  const bodyH = 7 + sz;
  const hip = BASE - 4;
  const sh = hip - bodyH;
  cv.rect(12, hip, 3, 5, 'c'); // legs
  cv.rect(11, BASE, 4, 1, 'pupil');
  cv.poly([[9 - Math.ceil(sz / 2), sh], [16, sh], [16, hip + 1], [10 - Math.ceil(sz / 2), hip + 1]], 'a');
  cv.rect(7 - Math.ceil(sz / 2), sh + 1, 2, bodyH - 1, 'a'); // arm
  cv.rect(7 - Math.ceil(sz / 2), sh + bodyH, 2, 2, 'd'); // hand
  cv.poly([[13, sh], [16, sh], [16, sh + 5]], 'eye'); // shirt
  cv.rect(13, sh - 7, 3, 6, 'd'); // head
  const hat = r.pick(['top', 'bowler', 'hair'] as const);
  if (hat === 'top') { cv.rect(12, sh - 13, 4, 5, 'c'); cv.rect(10, sh - 8, 6, 1, 'c'); cv.rect(12, sh - 10, 4, 1, 'b'); }
  else if (hat === 'bowler') { cv.ellipse(15.5, sh - 8, 3.5, 2, 'c'); cv.rect(11, sh - 7, 5, 1, 'c'); }
  else cv.rect(13, sh - 8, 3, 2, 'c');
  cv.mirror();
  cv.rect(15, sh + 1, 2, 1, 'b'); cv.rect(15, sh + 2, 2, 4, 'b'); // tie
  cv.set(14, sh - 4, 'pupil'); cv.set(17, sh - 4, 'pupil');
  if (r.chance(0.5)) { cv.set(13, sh - 4, 'b'); cv.set(18, sh - 4, 'b'); cv.rect(15, sh - 4, 2, 1, 'b'); } // glasses
  if (r.chance(0.6)) { cv.rect(23 + Math.ceil(sz / 2), hip - 2, 5, 4, 'b'); cv.rect(24 + Math.ceil(sz / 2), hip - 3, 3, 1, 'c'); } // briefcase
}

function whale(cv: Canvas) {
  cv.poly([[2, 12], [6, 15], [2, 19], [5, 19], [8, 16]], 'a'); // tail
  cv.ellipse(17, 19, 12, 7, 'a');
  cv.ellipse(18, 22, 9, 3, 'd'); // belly
  cv.rect(19, 4, 6, 5, 'c'); cv.rect(17, 9, 10, 1, 'c'); cv.rect(19, 7, 6, 1, 'b'); // top hat
  cv.set(24, 16, 'pupil'); cv.ellipse(24, 16, 1.5, 1.5, 'b'); cv.set(24, 16, 'pupil'); // monocle
  cv.line(26, 18, 27, 21, 'b');
}

function vault(cv: Canvas, r: Rng, door: Ramp = 'a', dial: Ramp = 'b') {
  cv.rect(6, 8, 20, 20, 'c');
  cv.rect(8, 10, 16, 16, door);
  cv.ellipse(15.5, 17.5, 4, 4, dial);
  cv.ellipse(15.5, 17.5, 1.5, 1.5, 'c');
  cv.line(15, 13, 15, 15, 'c');
  cv.rect(25, 12, 1, 3, 'b'); cv.rect(25, 21, 1, 3, 'b'); // hinges
  cv.rect(8, BASE, 3, 1, 'c'); cv.rect(21, BASE, 3, 1, 'c');
  if (r.chance(0.5)) cv.set(21, 12, 'glow');
}

function tower(cv: Canvas, r: Rng, c: CardDef) {
  const sz = sizeClass(c);
  const w = 10 + 2 * Math.min(sz, 3), h = 14 + sz * 2;
  const top = BASE - h + 1;
  cv.rect(16 - w / 2, top, w / 2, h, 'c');
  cv.mirror();
  for (let y = top + 2; y < BASE - 1; y += 3) {
    cv.rect(16 - w / 2 + 1, y, w - 2, 1, 'a');
    cv.set(16 + w / 2 - 3, y, r.chance(0.7) ? 'glow' : 'b');
  }
}

function cube(cv: Canvas) {
  cv.poly([[16, 6], [27, 11], [16, 16], [5, 11]], 'b'); // top
  cv.poly([[5, 11], [16, 16], [16, 28], [5, 23]], 'a'); // left
  cv.poly([[16, 16], [27, 11], [27, 23], [16, 28]], 'c'); // right
  cv.line(16, 16, 16, 27, 'glow');
  cv.line(9, 13, 9, 22, 'd'); cv.line(22, 14, 22, 24, 'd');
}

function critter(cv: Canvas, r: Rng, c: CardDef) {
  const sz = sizeClass(c);
  const body = r.pick(['a', 'b', 'c'] as const);
  const rx = 6 + sz, ry = 5 + Math.min(sz, 3);
  const cx = 15.5 + r.int(-1, 1), cy = BASE - ry;
  const app = r.pick(['ears', 'antennae', 'horns', 'sprout'] as const);
  if (app === 'ears') { cv.poly([[cx - rx + 1, cy - ry + 3], [cx - rx + 2, cy - ry - 4], [cx - rx + 6, cy - ry + 1]], body); cv.poly([[cx + rx - 1, cy - ry + 3], [cx + rx - 1, cy - ry - 3], [cx + rx - 5, cy - ry + 1]], body); }
  else if (app === 'antennae') { cv.line(Math.round(cx - 3), cy - ry, Math.round(cx - 5), cy - ry - 4, 'pupil'); cv.line(Math.round(cx + 3), cy - ry, Math.round(cx + 6), cy - ry - 3, 'pupil'); }
  else if (app === 'horns') { cv.poly([[cx - 4, cy - ry + 1], [cx - 5, cy - ry - 4], [cx - 2, cy - ry]], 'b'); cv.poly([[cx + 4, cy - ry + 1], [cx + 6, cy - ry - 3], [cx + 2, cy - ry]], 'b'); }
  else { cv.line(Math.round(cx), cy - ry, Math.round(cx), cy - ry - 3, 'b'); cv.ellipse(cx + 2, cy - ry - 3, 2, 1, 'b'); }
  cv.ellipse(cx, cy, rx, ry, body);
  cv.rect(Math.round(cx - rx / 2) - 1, BASE, 3, 1, body === 'c' ? 'a' : 'c');
  cv.rect(Math.round(cx + rx / 2) - 1, BASE, 3, 1, body === 'c' ? 'a' : 'c');
  // Off-model eyes: one big, one small, looking right.
  const e1 = 2 + r.int(0, 1) + (sz >= 3 ? 1 : 0), e2 = Math.max(1, e1 - r.int(1, 2));
  cv.ellipse(cx - 3, cy - 2, e1, e1, 'eye'); cv.ellipse(cx + 3, cy - 2, e2, e2 + 0.5, 'eye');
  cv.rect(Math.round(cx - 3 + e1 / 2), cy - 2, 1, 2, 'pupil'); cv.set(Math.round(cx + 3 + e2 / 2), cy - 2, 'pupil');
  cv.line(Math.round(cx - 3), cy + 3, Math.round(cx + 3), cy + 3, 'pupil');
  cv.set(Math.round(cx - 4), cy + 2, 'pupil'); cv.set(Math.round(cx + 4), cy + 2, 'pupil');
  cv.set(Math.round(cx), cy + 4, 'eye'); // tooth
  if (has(c, 'paper')) { cv.rect(Math.round(cx + rx - 1), cy, 4, 5, 'eye'); cv.line(Math.round(cx + rx), cy + 2, Math.round(cx + rx + 2), cy + 2, 'c'); }
  if (has(c, 'hype')) cv.poly([[cx + rx - 1, cy + 1], [cx + rx + 5, cy - 2], [cx + rx + 5, cy + 4]], 'd'); // megaphone
}

function frog(cv: Canvas) {
  cv.ellipse(15.5, 21, 11, 6, 'b');
  cv.ellipse(10, 14, 3, 3, 'b'); cv.ellipse(21, 14, 3, 3, 'b');
  cv.ellipse(10, 14, 1.5, 1.5, 'eye'); cv.ellipse(21, 14, 1.5, 1.5, 'eye');
  cv.set(11, 14, 'pupil'); cv.set(22, 14, 'pupil');
  cv.line(8, 22, 23, 22, 'pupil'); cv.set(7, 21, 'pupil'); cv.set(24, 21, 'pupil');
  cv.ellipse(15.5, 25, 6, 2, 'd'); // pumped throat
  cv.rect(4, BASE - 1, 5, 2, 'b'); cv.rect(23, BASE - 1, 5, 2, 'b');
}

function dragon(cv: Canvas) {
  cv.poly([[8, 9], [16, 14], [10, 20], [3, 15]], 'c'); // wing
  cv.poly([[3, 25], [8, 22], [10, 26], [5, 28]], 'a'); // tail
  cv.ellipse(14, 21, 7, 5, 'a');
  cv.poly([[18, 18], [22, 11], [25, 13], [21, 20]], 'a'); // neck
  cv.ellipse(25, 10, 4, 3, 'a'); // head
  cv.poly([[23, 6], [24, 3], [25, 7]], 'b'); cv.poly([[26, 6], [28, 3], [28, 7]], 'b'); // horns
  cv.set(26, 9, 'eye'); cv.set(27, 9, 'pupil');
  cv.line(27, 12, 29, 12, 'pupil');
  cv.rect(10, BASE - 1, 3, 2, 'a'); cv.rect(16, BASE - 1, 3, 2, 'a');
  cv.set(29, 11, 'glow'); cv.set(30, 10, 'glow'); // flame spark
}

function runner(cv: Canvas) {
  cv.ellipse(18, 9, 3, 3, 'b'); // head
  cv.rect(15, 8, 7, 2, 'd'); cv.rect(10, 9, 5, 1, 'd'); // headband + scarf trailing
  cv.poly([[15, 12], [21, 12], [20, 20], [14, 20]], 'a'); // torso leaning
  cv.line(15, 14, 11, 18, 'a'); cv.line(21, 14, 25, 12, 'a'); // arms swinging
  cv.line(15, 20, 11, 27, 'c'); cv.line(19, 20, 23, 26, 'c'); cv.line(23, 26, 25, 26, 'c');
  cv.set(19, 9, 'pupil');
  for (let y = 13; y <= 19; y += 3) cv.line(4, y, 7, y, 'glow'); // speed lines
}

function hooded(cv: Canvas, r: Rng, c: CardDef) {
  robed(cv, r, c, { trim: 'd', robe: 'a' });
  cv.ellipse(26, 14, 2.5, 2.5, 'd'); cv.ellipse(26, 14, 1, 1, 'glow'); cv.line(24, 16, 23, 18, 'c'); // lens
}

function knight(cv: Canvas, r: Rng, c: CardDef) {
  robot(cv, r, c);
  cv.poly([[3, 14], [10, 14], [10, 21], [6.5, 25], [3, 21]], 'd'); // shield
  cv.line(5, 19, 6, 20, 'glow'); cv.line(6, 20, 8, 17, 'glow'); // check mark
}

// ─── Icons for actions, predictions and assets ────────────────────────────────
function chipBolt(cv: Canvas) {
  cv.rect(8, 8, 16, 16, 'c');
  for (let i = 10; i <= 21; i += 3) { cv.rect(i, 6, 1, 2, 'a'); cv.rect(i, 24, 1, 2, 'a'); cv.rect(6, i, 2, 1, 'a'); cv.rect(24, i, 2, 1, 'a'); }
  cv.poly([[17, 9], [11, 17], [15, 17], [13, 23], [21, 14], [17, 14], [19, 9]], 'b');
  cv.set(15, 16, 'glow');
}

function firewall(cv: Canvas) {
  for (let row = 0; row < 5; row++) {
    const y = 13 + row * 3, off = row % 2 ? 2 : 0;
    for (let x = 3 + off; x < 28; x += 5) cv.rect(x, y, 4, 2, 'a');
  }
  for (let x = 4; x < 28; x += 4) cv.poly([[x, 12], [x + 1.5, 6 + (x % 3)], [x + 3, 12]], 'b');
  for (let x = 5; x < 28; x += 8) cv.set(x + 1, 10, 'glow');
}

function crystalBall(cv: Canvas, r: Rng) {
  cv.ellipse(15.5, 13, 8, 8, 'd');
  cv.poly([[10, 21], [21, 21], [23, 26], [8, 26]], 'b');
  cv.rect(7, 26, 18, 2, 'b');
  for (let i = 0; i < 4; i++) cv.set(r.int(11, 20), r.int(9, 17), 'glow');
  cv.set(12, 9, 'eye'); cv.set(13, 8, 'eye');
}

function teacup(cv: Canvas) {
  cv.poly([[6, 14], [25, 14], [22, 24], [9, 24]], 'eye');
  cv.rect(6, 14, 20, 1, 'b');
  cv.ellipse(27, 18, 2, 3, 'b'); cv.ellipse(27, 18, 0.6, 1.5, null);
  cv.rect(5, 25, 22, 2, 'b');
  cv.set(12, 13, 'c'); cv.set(15, 13, 'c'); cv.set(19, 13, 'c');
  for (let i = 0; i < 3; i++) cv.line(11 + i * 4, 10, 12 + i * 4, 6, 'glow'); // steam
}

function starChart(cv: Canvas, r: Rng) {
  cv.rect(5, 7, 22, 18, 'a');
  cv.rect(4, 6, 2, 20, 'b'); cv.rect(26, 6, 2, 20, 'b');
  const pts: [number, number][] = Array.from({ length: 5 }, (_, i) => [8 + i * 4 + r.int(0, 1), r.int(10, 21)]);
  for (let i = 1; i < pts.length; i++) cv.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], 'd');
  for (const [x, y] of pts) cv.set(x, y, 'glow');
}

function dice(cv: Canvas) {
  cv.rect(5, 12, 11, 11, 'b'); cv.rect(17, 8, 10, 10, 'b');
  for (const [x, y] of [[7, 14], [10, 17], [13, 20]] as const) cv.set(x, y, 'pupil');
  for (const [x, y] of [[19, 10], [24, 10], [19, 15], [24, 15]] as const) cv.set(x, y, 'pupil');
  cv.set(9, 9, 'glow'); cv.set(15, 6, 'glow');
}

function coins(cv: Canvas) {
  const stack = (x: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const y = 25 - i * 3;
      cv.rect(x, y, 10, 2, 'b');
      cv.rect(x, y + 2, 10, 1, 'c'); // seam between coins
    }
    cv.ellipse(x + 4.5, 25 - (n - 1) * 3 - 1, 4.5, 1, 'b'); // top face
  };
  stack(4, 4);
  stack(16, 6);
  cv.set(20, 25 - 5 * 3 - 1, 'glow');
  cv.poly([[24, 2], [29, 7], [26, 7], [26, 10], [22, 10], [22, 7], [19, 7]], 'a'); // up arrow
}

function rocket(cv: Canvas) {
  cv.poly([[16, 3], [20, 9], [20, 21], [12, 21], [12, 9]], 'c');
  cv.poly([[16, 3], [20, 9], [12, 9]], 'a');
  cv.ellipse(16, 13, 2, 2, 'eye'); cv.set(16, 13, 'b');
  cv.poly([[12, 16], [8, 23], [12, 21]], 'b'); cv.poly([[20, 16], [24, 23], [20, 21]], 'b');
  cv.poly([[13, 22], [19, 22], [16, 29]], 'd'); cv.rect(15, 22, 2, 3, 'glow');
}

function rug(cv: Canvas) {
  cv.poly([[4, 18], [22, 9], [28, 15], [10, 24]], 'a');
  cv.line(8, 18, 23, 11, 'c'); cv.line(10, 21, 25, 14, 'b');
  for (const [x, y] of [[3, 19], [5, 21], [27, 14], [28, 16]] as const) cv.set(x, y, 'b');
  cv.poly([[18, 25], [24, 22], [26, 27]], 'b'); // the yank
}

function arrowUp(cv: Canvas) {
  cv.poly([[16, 3], [26, 13], [20, 13], [20, 27], [12, 27], [12, 13], [6, 13]], 'b');
  cv.rect(14, 22, 4, 5, 'glow');
  cv.set(9, 22, 'd'); cv.set(23, 24, 'd'); cv.set(25, 19, 'd');
}

function parachute(cv: Canvas) {
  cv.ellipse(15.5, 11, 11, 7, 'b'); cv.rect(4, 11, 24, 8, null);
  cv.rect(5, 11, 22, 1, 'a');
  cv.line(5, 12, 13, 21, 'c'); cv.line(26, 12, 18, 21, 'c'); cv.line(15, 12, 15, 21, 'c');
  cv.rect(11, 21, 10, 7, 'd'); cv.line(11, 24, 20, 24, 'c');
}

function hammer(cv: Canvas) {
  cv.line(14, 13, 24, 27, 'd'); cv.line(15, 13, 25, 27, 'd'); // handle
  cv.rect(5, 6, 16, 8, 'a'); // head
  cv.rect(3, 7, 2, 6, 'b'); cv.rect(21, 7, 2, 6, 'b'); // striking faces
  cv.rect(12, 8, 2, 4, 'c'); // eye of the hammer
  cv.set(6, 7, 'glow');
}

function fork(cv: Canvas) {
  cv.rect(14, 18, 4, 10, 'b');
  cv.poly([[14, 19], [7, 11], [7, 4], [11, 4], [11, 10], [16, 15]], 'a');
  cv.poly([[18, 19], [25, 11], [25, 4], [21, 4], [21, 10], [16, 15]], 'd');
  cv.set(9, 5, 'glow'); cv.set(23, 5, 'glow');
}

function scroll(cv: Canvas) {
  cv.rect(7, 7, 18, 18, 'b');
  cv.rect(5, 6, 22, 2, 'd'); cv.rect(5, 24, 22, 2, 'd');
  for (let y = 11; y < 22; y += 3) cv.line(10, y, 21, y, 'c');
}

function bond(cv: Canvas) {
  cv.rect(7, 8, 18, 16, 'd');
  cv.rect(6, 7, 2, 18, 'b'); cv.rect(24, 7, 2, 18, 'b');
  for (let y = 12; y < 21; y += 3) cv.line(10, y, 20, y, 'c');
  cv.ellipse(20, 20, 2, 2, 'a');
}

// ─── Poncho collab set ────────────────────────────────────────────────────────
interface CatOpts { taco?: boolean; /** Sombrero; on by default (Poncho's signature look). */ hat?: boolean; guitar?: boolean; salsa?: boolean; tail?: boolean }

/**
 * Poncho as on his profile picture: ginger chibi cat with a white muzzle, big shiny eyes, blush and an open
 * smile; blue sombrero with a red zigzag band; blue poncho with red and white triangles and a red zigzag collar.
 * Feet on `base`, scaled by `k` (1 = full card size).
 */
function ponchoCat(cv: Canvas, cx: number, base: number, k: number, o: CatOpts = {}) {
  const S = (v: number) => Math.round(v * k);
  const top = base - S(10);
  const hat = o.hat !== false;
  // Tail first, so the poncho overlaps its root (right side; the taco is held up on the left).
  if (o.tail !== false && !o.guitar) {
    cv.line(cx + S(7), base - S(2), cx + S(11), base - S(7), 'a');
    cv.line(cx + S(7), base - S(1), cx + S(12), base - S(7), 'a');
  }
  // Poncho: blue, a red zigzag collar, a row of red triangles and a row of white ones.
  cv.poly([[cx - S(3), top], [cx + S(3) + 1, top], [cx + S(9) + 1, base], [cx - S(9), base]], 'c');
  const onPoncho = (x: number, y: number, m: Mat) => { if (cv.get(x, y) === 'c') cv.set(x, y, m); };
  for (let x = cx - S(4); x <= cx + S(4) + 1; x++) { onPoncho(x, top, 'b'); if ((x - cx) % 2 === 0) onPoncho(x, top + 1, 'b'); }
  const tri = (y: number, m: Mat, down: boolean, step: number) => {
    for (let x0 = cx - S(9); x0 <= cx + S(9); x0 += step) {
      onPoncho(x0, y + (down ? 1 : 0), m); onPoncho(x0 - 1, y + (down ? 0 : 1), m); onPoncho(x0 + 1, y + (down ? 0 : 1), m); onPoncho(x0, y + (down ? 0 : 1), m);
    }
  };
  if (k >= 0.6) { tri(top + S(4), 'b', true, 4); tri(top + S(7), 'eye', false, 4); }
  else { for (let x = cx - S(9); x <= cx + S(9); x += 2) onPoncho(x, top + S(5), 'b'); }
  cv.rect(cx - S(5), base, Math.max(1, S(2)), 1, 'a'); cv.rect(cx + S(4), base, Math.max(1, S(2)), 1, 'a'); // feet
  // Head: ginger with a white muzzle, ears with pink insides.
  const hy = top - S(5);
  cv.poly([[cx - S(7), hy - S(2)], [cx - S(6), hy - S(9)], [cx - S(1), hy - S(5)]], 'a');
  cv.poly([[cx + S(7) + 1, hy - S(2)], [cx + S(6) + 1, hy - S(9)], [cx + S(1) + 1, hy - S(5)]], 'a');
  cv.ellipse(cx + 0.5, hy, S(7), S(6), 'a');
  cv.set(cx - S(5), hy - S(6), 'b'); cv.set(cx + S(5) + 1, hy - S(6), 'b');
  cv.ellipse(cx + 0.5, hy + S(3), S(4), S(2.2), 'eye'); // white muzzle, lower face only
  const ew = Math.max(1, S(2)), eh = k >= 0.9 ? 3 : ew; // big, tall, shiny eyes
  const ex = [cx - S(4), cx + S(3)];
  for (const x of ex) cv.rect(x, hy - S(1), ew, eh, 'pupil');
  if (k >= 0.6) for (const x of ex) cv.set(x, hy - S(1), 'eye'); // catchlights
  cv.set(cx, hy + S(1.5), 'pupil'); cv.set(cx + 1, hy + S(1.5), 'pupil'); // nose
  if (k >= 0.9) {
    cv.set(cx, hy + S(3), 'b'); cv.set(cx + 1, hy + S(3), 'b'); // open smile, tongue
    cv.set(cx - S(6), hy + S(2), 'b'); cv.set(cx + S(6) + 1, hy + S(2), 'b'); // blush
  } else cv.set(cx, hy + S(2.5), 'b');
  if (hat) {
    const by = hy - S(5);
    cv.ellipse(cx + 0.5, by, S(11), Math.max(1, S(1.6)), 'c'); // brim
    if (k >= 0.9) for (let x = cx - S(10); x <= cx + S(10) + 1; x++) { // red zigzag band
      const y = by + ((((x - cx) % 4) + 4) % 4 < 2 ? 0 : 1);
      if (cv.get(x, y) === 'c') cv.set(x, y, 'b');
    }
    cv.ellipse(cx + 0.5, by - S(3), S(4), S(3), 'c'); // crown
    cv.rect(cx - S(3), by - S(3), S(6) + 1, 1, 'b'); cv.rect(cx - S(2), by - S(5), S(4) + 1, 1, 'b'); // crown stripes
  }
  if (o.taco) { // held up on the left, beside the cheek, as on the profile picture
    const tx = cx - S(9), ty = hy + S(4);
    taco(cv, tx, ty, Math.max(2, S(3.5)), Math.max(2, S(3)));
    cv.rect(tx + S(2), ty + S(1), Math.max(1, S(2)), Math.max(1, S(2)), 'a'); // paw
  }
  if (o.salsa) {
    const bx = cx - S(10), by = top + S(1);
    cv.rect(bx, by, S(3), S(6), 'b'); cv.rect(bx + 1, by - S(2), Math.max(1, S(1)), S(2), 'd'); // bottle + nozzle
    cv.rect(bx + S(3), by + S(3), Math.max(1, S(2)), Math.max(1, S(2)), 'a'); // paw
  }
  if (o.guitar) {
    const gx = cx + S(6), gy = top + S(6);
    cv.line(gx, gy, gx + S(6), gy - S(10), 'a'); cv.line(gx + 1, gy, gx + S(6) + 1, gy - S(10), 'a'); // neck
    cv.ellipse(gx, gy, S(3), S(3), 'd'); cv.set(gx, gy, 'pupil'); // body + sound hole
    cv.rect(gx - S(3), gy - S(3), Math.max(1, S(2)), Math.max(1, S(2)), 'a'); // strumming paw
  }
}

/** Side-view taco: a half-moon shell (round side down) with lettuce and salsa on top. */
function taco(cv: Canvas, cx: number, cy: number, rx: number, ry: number) {
  for (let y = cy; y <= cy + ry; y++) for (let x = cx - rx; x <= cx + rx; x++) {
    const dx = (x - cx) / (rx + 0.35), dy = (y - cy) / (ry + 0.35);
    if (dx * dx + dy * dy <= 1) cv.set(x, y, 'd');
  }
  for (let x = cx - rx + 1; x <= cx + rx - 1; x++) {
    cv.set(x, cy - 1, (x + cx) % 3 === 0 ? 'b' : 'glow');
    if ((x + cx) % 2 === 0 && rx >= 4) cv.set(x, cy - 2, 'glow');
  }
}

function tacoTruck(cv: Canvas) {
  cv.rect(3, 13, 20, 12, 'c'); // box
  cv.rect(23, 16, 6, 9, 'c'); cv.rect(24, 17, 4, 3, 'eye'); // cab + windshield
  cv.rect(6, 16, 12, 5, 'pupil'); // serving hatch
  ponchoCatHead(cv, 12, 20); // the chef peeking out
  for (let x = 4; x < 22; x++) cv.set(x, 12, x % 4 < 2 ? 'b' : 'd'); // awning
  cv.ellipse(8, 25, 2, 2, 'pupil'); cv.ellipse(24, 25, 2, 2, 'pupil'); // wheels
  cv.set(8, 25, 'a'); cv.set(24, 25, 'a');
  taco(cv, 12, 8, 5, 3); // roof sign
}

function ponchoCatHead(cv: Canvas, cx: number, cy: number) {
  cv.poly([[cx - 3, cy - 1], [cx - 3, cy - 4], [cx - 1, cy - 2]], 'a');
  cv.poly([[cx + 4, cy - 1], [cx + 4, cy - 4], [cx + 2, cy - 2]], 'a');
  cv.ellipse(cx + 0.5, cy, 3, 2, 'a');
  cv.set(cx - 1, cy, 'pupil'); cv.set(cx + 2, cy, 'pupil'); cv.set(cx, cy + 1, 'b'); cv.set(cx + 1, cy + 1, 'b');
}

function poncho(cv: Canvas, c: CardDef) {
  switch (c.slug) {
    case 'poncho-kitten': return ponchoCat(cv, 18, BASE, 0.75, { taco: true, hat: false });
    case 'taco-tuesday': taco(cv, 10, 18, 7, 6); taco(cv, 21, 12, 7, 6); return;
    case 'taco-token': return taco(cv, 16, 16, 10, 8);
    case 'salsa-slinger': return ponchoCat(cv, 18, BASE, 1, { salsa: true, hat: false });
    case 'sombrero-sentry': return ponchoCat(cv, 16, BASE, 1);
    case 'taco-truck': return tacoTruck(cv);
    case 'poncho-posse':
      ponchoCat(cv, 6, BASE - 6, 0.5, { tail: false }); ponchoCat(cv, 26, BASE - 6, 0.5, { tail: false });
      return ponchoCat(cv, 17, BASE, 0.65, { taco: true, tail: false, hat: false });
    case 'mariachi-cat': return ponchoCat(cv, 14, BASE, 1, { guitar: true });
    default: return ponchoCat(cv, 18, BASE, 1, { taco: true }); // Poncho
  }
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────
function draw(cv: Canvas, r: Rng, c: CardDef) {
  const f = c.faction;
  if (c.set === 'poncho') return poncho(cv, c);
  if (c.type === 'prediction') return has(c, 'tea') ? teacup(cv) : has(c, 'star') ? starChart(cv, r) : crystalBall(cv, r);
  if (c.type === 'asset') return firewall(cv);
  if (c.type === 'action') {
    if (has(c, 'rug')) return rug(cv);
    if (has(c, 'lever')) return arrowUp(cv);
    if (has(c, 'airdrop')) return parachute(cv);
    if (has(c, 'liquidat')) return hammer(cv);
    if (has(c, 'fork')) return fork(cv);
    return f === 'agents' ? chipBolt(cv) : f === 'prophets' ? dice(cv) : f === 'brokers' ? coins(cv) : f === 'degens' ? rocket(cv) : scroll(cv);
  }
  // Units (and tokens)
  if (has(c, 'drone')) return drone(cv, r);
  if (has(c, 'bond') && c.cost === 0) return bond(cv);
  if (has(c, 'eye')) return bigEye(cv);
  if (has(c, 'whale')) return whale(cv);
  if (has(c, 'vault', 'wallet')) return vault(cv, r, f === 'neutral' ? 'b' : 'a', f === 'neutral' ? 'd' : 'b');
  if (has(c, 'frog')) return frog(cv);
  if (has(c, 'dragon')) return dragon(cv);
  if (has(c, 'node', 'mainframe')) return tower(cv, r, c);
  if (has(c, 'genesis', 'block')) return cube(cv);
  if (has(c, 'runner')) return runner(cv);
  if (has(c, 'searcher')) return hooded(cv, r, c);
  if (has(c, 'validator')) return knight(cv, r, c);
  if (f === 'agents') return robot(cv, r, c);
  if (f === 'prophets') return robed(cv, r, c, { trim: 'b', robe: 'a' });
  if (f === 'brokers') return suit(cv, r, c);
  if (f === 'degens') return critter(cv, r, c);
  return knight(cv, r, c);
}

/** Final colors per pixel (null = transparent), after shading, outline and race accents. */
export function spritePixels(cardId: number): (string | null)[] {
  const c = card(cardId);
  const pal: RacePalette = paletteFor(c);
  const r = rng(cardId * 7919 + 17);
  const cv = new Canvas();
  draw(cv, r, c);

  const out: (string | null)[] = Array(N * N).fill(null);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const m = cv.get(x, y);
      if (!m) continue;
      if (!isRamp(m)) { out[y * N + x] = pal[m]; continue; }
      // One light from the top left: lit edges get the highlight, shadowed edges the shadow.
      const lit = cv.get(x - 1, y) !== m || cv.get(x, y - 1) !== m;
      const dark = cv.get(x + 1, y) !== m || cv.get(x, y + 1) !== m;
      const shade = lit && !dark ? 2 : dark && !lit ? 0 : 1;
      out[y * N + x] = pal[m][shade];
      // Agents: metallic glints on lit chrome.
      if (c.faction === 'agents' && m === 'a' && shade === 2 && r.chance(0.18)) out[y * N + x] = '#ffffff';
    }
  }
  // 1 px outline in the race's darkest shade.
  const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < N && y < N && !!cv.get(x, y);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (!cv.get(x, y) && (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1))) out[y * N + x] = pal.outline;
  }
  // Degens: white sticker border around the outline.
  if (c.faction === 'degens') {
    const snap = out.slice();
    const isOutline = (x: number, y: number) => x >= 0 && y >= 0 && x < N && y < N && snap[y * N + x] === pal.outline;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (!snap[y * N + x] && (isOutline(x - 1, y) || isOutline(x + 1, y) || isOutline(x, y - 1) || isOutline(x, y + 1))) out[y * N + x] = '#ffffff';
    }
  }
  // Glow pixels floating around Prophets and Legendaries.
  const sparkles = (c.faction === 'prophets' ? 4 : 0) + (c.rarity === 'legendary' ? 5 : 0);
  if (sparkles) {
    cv.sparkle(r, sparkles);
    for (const i of cv.sparkles) if (!out[i]) out[i] = pal.glow;
  }
  return out;
}

/** The sprite as a compact SVG (horizontal runs merged), transparent background, crisp at any integer scale. */
export function spriteSvg(cardId: number): string {
  const px = spritePixels(cardId);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" shape-rendering="crispEdges">${spriteRects(px)}</svg>`;
}

export function spriteRects(px: (string | null)[]): string {
  const parts: string[] = [];
  for (let y = 0; y < N; y++) {
    let x = 0;
    while (x < N) {
      const col = px[y * N + x];
      if (!col) { x++; continue; }
      let w = 1;
      while (x + w < N && px[y * N + x + w] === col) w++;
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="1" fill="${col}"/>`);
      x += w;
    }
  }
  return parts.join('');
}

const uriCache = new Map<number, string>();
/** Data URI for <img src>; cached. */
export function spriteDataUri(cardId: number): string {
  let u = uriCache.get(cardId);
  if (!u) { u = `data:image/svg+xml;base64,${toBase64(spriteSvg(cardId))}`; uriCache.set(cardId, u); }
  return u;
}

export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
