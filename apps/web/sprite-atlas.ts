/**
 * Build-time sprite atlas: every pixel-art card sprite from @forkfall/art in one PNG, so the browser decodes a single
 * small image instead of generating ~170 SVGs on the main thread (sprites depend on all earlier ones, which made the
 * first late-numbered card on screen pay for most of the set). Runs in Node from vite.config.ts; pure functions, so
 * the unit tests can check the atlas against spritePixels.
 */
import { deflateSync, crc32 } from 'node:zlib';
import { CARDS } from '@forkfall/engine';
import { SPRITE_SIZE, spritePixels } from '../../packages/art/src/sprite.ts';
import { isPonchoArt } from '../../packages/art/src/poncho.ts';

/** Transparent gutter around each sprite: scaled backgrounds never bleed a neighbour's edge pixels. */
export const ATLAS_PAD = 2;
export const ATLAS_CELL = SPRITE_SIZE + ATLAS_PAD * 2;
export const ATLAS_COLS = 16;

export interface Atlas { png: Buffer; cols: number; rows: number; cell: number; pad: number; index: Record<number, number> }

/** Cards drawn as pixel sprites (the Poncho set uses its own artwork). */
export const atlasCardIds = (): number[] => CARDS.map((c) => c.id).filter((id) => !isPonchoArt(id));

export function buildAtlas(ids: number[] = atlasCardIds()): Atlas {
  const cols = ATLAS_COLS, rows = Math.ceil(ids.length / cols);
  const w = cols * ATLAS_CELL, h = rows * ATLAS_CELL;
  const rgba = Buffer.alloc(w * h * 4);
  const index: Record<number, number> = {};
  ids.forEach((id, i) => {
    index[id] = i;
    const ox = (i % cols) * ATLAS_CELL + ATLAS_PAD, oy = Math.floor(i / cols) * ATLAS_CELL + ATLAS_PAD;
    const px = spritePixels(id);
    for (let y = 0; y < SPRITE_SIZE; y++) for (let x = 0; x < SPRITE_SIZE; x++) {
      const c = px[y * SPRITE_SIZE + x];
      if (!c) continue;
      const o = ((oy + y) * w + ox + x) * 4;
      rgba[o] = parseInt(c.slice(1, 3), 16); rgba[o + 1] = parseInt(c.slice(3, 5), 16); rgba[o + 2] = parseInt(c.slice(5, 7), 16); rgba[o + 3] = 255;
    }
  });
  return { png: encodePng(w, h, rgba), cols, rows, cell: ATLAS_CELL, pad: ATLAS_PAD, index };
}

/** Minimal RGBA PNG encoder (filter 0 on every row, one IDAT). */
export function encodePng(w: number, h: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
