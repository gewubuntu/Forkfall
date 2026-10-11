import { readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CARDS } from '@forkfall/engine';
import { SPRITE_SIZE, spritePixels } from '../../../packages/art/src/sprite.ts';
import { ATLAS_CELL, ATLAS_PAD, atlasCardIds, buildAtlas } from '../sprite-atlas.ts';

/** RGBA pixels back out of the atlas PNG (filter 0 rows, as encodePng writes them). */
function decode(png: Buffer) {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  let p = 8; const idat: Buffer[] = [];
  while (p < png.length) {
    const len = png.readUInt32BE(p), type = png.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') idat.push(png.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const at = (x: number, y: number) => { const o = y * (w * 4 + 1) + 1 + x * 4; return [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]]; };
  return { w, h, at };
}
const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

describe('sprite atlas (web build)', () => {
  const atlas = buildAtlas();
  const png = decode(atlas.png);

  it('holds every pixel-art card, and no Poncho artwork', () => {
    const ids = atlasCardIds();
    expect(Object.keys(atlas.index).map(Number).sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
    expect(ids.length).toBeGreaterThan(100);
    expect(ids).not.toContain(48); // Poncho set: its own artwork
    expect(png.w).toBe(atlas.cols * ATLAS_CELL);
    expect(png.h).toBe(atlas.rows * ATLAS_CELL);
  });

  it('draws each card exactly as spritePixels does, with a transparent gutter', () => {
    for (const id of atlasCardIds()) {
      const i = atlas.index[id], px = spritePixels(id);
      const ox = (i % atlas.cols) * ATLAS_CELL + ATLAS_PAD, oy = Math.floor(i / atlas.cols) * ATLAS_CELL + ATLAS_PAD;
      for (let y = 0; y < SPRITE_SIZE; y++) for (let x = 0; x < SPRITE_SIZE; x++) {
        const c = px[y * SPRITE_SIZE + x];
        expect(png.at(ox + x, oy + y)).toEqual(c ? [...hex(c), 255] : [0, 0, 0, 0]);
      }
      expect(png.at(ox - 1, oy)[3]).toBe(0);
      expect(png.at(ox, oy - 1)[3]).toBe(0);
    }
  });
});

describe('Poncho artwork for the web', () => {
  it('has a WebP copy of every generated image (run pnpm art:poncho-web after adding one)', () => {
    const src = readdirSync(new URL('../../../packages/art/assets/poncho', import.meta.url)).filter((f) => /^\d+\.(jpe?g|png)$/i.test(f)).map((f) => f.split('.')[0]);
    const web = readdirSync(new URL('../src/assets/poncho', import.meta.url)).filter((f) => f.endsWith('.webp')).map((f) => f.split('.')[0]);
    expect(web.sort()).toEqual(src.sort());
    expect(CARDS.some((c) => c.id === 48)).toBe(true);
  });
});
