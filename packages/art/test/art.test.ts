import { CARDS, COLLECTIBLE, keccakHex } from '@forkfall/engine';
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cardMetadata, cardSvg, collectionMetadata, ponchoArt, ponchoSvg, PONCHO_IMAGES, erc1155IdHex, paletteFor, parseTokenId, PALETTES, PONCHO_PALETTE, SPRITE_SIZE, spritePixels, spriteSvg,
  STARTER_OFFSET, tokenIds, wrap,
} from '../src/index.ts';

const N = SPRITE_SIZE;

describe('sprites follow the pixel style guide', () => {
  for (const c of CARDS) {
    it(`${c.id} ${c.name}`, () => {
      const px = spritePixels(c.id);
      const colors = new Set(px.filter(Boolean));
      expect(colors.size).toBeLessThanOrEqual(16); // at most 16 colors per sprite
      const filled = px.filter(Boolean).length;
      expect(filled).toBeGreaterThan(60);
      expect(filled).toBeLessThan(N * N * 0.8);
      // Transparent background: corners empty, and the 1 px outline (race's darkest shade) is present.
      expect([px[0], px[N - 1], px[N * N - 1]]).toEqual([null, null, null]);
      expect(colors.has(paletteFor(c).outline)).toBe(true);
      if (c.faction === 'degens') expect(colors.has('#ffffff')).toBe(true); // sticker outline
      expect(spriteSvg(c.id)).toBe(spriteSvg(c.id)); // deterministic
    });
  }
  it('every card gets its own sprite', () => {
    const keys = new Set(CARDS.map((c) => spritePixels(c.id).join()));
    expect(keys.size).toBe(CARDS.length);
  });
  it('cards after the first Prophets batch differ from every earlier sprite by at least 48 pixels', () => {
    const diff = (a: (string | null)[], b: (string | null)[]) => a.filter((x, i) => x !== b[i]).length;
    const legacy = (id: number) => id <= 57 || id >= 1000;
    for (const c of CARDS.filter((x) => !legacy(x.id))) {
      const px = spritePixels(c.id);
      for (const o of CARDS.filter((x) => legacy(x.id) || x.id < c.id)) expect(diff(px, spritePixels(o.id)), `${c.name} vs ${o.name}`).toBeGreaterThanOrEqual(48);
    }
  });
  it('adding cards never changes the art of earlier ones', () => {
    // Every sprite as of the first Prophets batch (ids 1–57 and the 3 tokens), pinned.
    const before = CARDS.filter((c) => c.id <= 57 || !c.collectible).map((c) => c.id).sort((a, b) => a - b);
    expect(before).toHaveLength(60);
    expect(keccakHex(...before.map((id) => spritePixels(id).join()))).toBe('0x130f252821c6def8ad4e73edd036fb79e392ee6f57b557b48183c4008cbefa36');
  });
});

describe('card frame', () => {
  it('shows rarity material, chain badge, stats, escaped text and the starter ribbon', () => {
    const legendary = cardSvg(8);
    expect(legendary).toContain('animateTransform'); // animated Legendary frame
    expect(legendary).toContain('>BASE<');
    expect(cardSvg(25)).toContain('>RH<');
    expect(cardSvg(33)).not.toMatch(/>BASE<|>RH</); // neutral: no chain badge
    expect(cardSvg(1)).toContain('aria-label="attack"');
    expect(cardSvg(3)).not.toContain('aria-label="attack"'); // actions have no stats
    expect(cardSvg(4, { starter: true })).toContain('STARTER · SOULBOUND');
    expect(cardSvg(4)).not.toContain('STARTER');
    expect(cardSvg(16)).toContain('The All-Seeing Eye');
  });
  it('wraps rules text within the line budget', () => {
    const lines = wrap('Deploy 3. Automate: at the start of your next turn, give all friendly units +1/+1.', 34, 4);
    expect(lines.every((l) => l.length <= 34)).toBe(true);
    expect(wrap('a '.repeat(200), 10, 2)).toHaveLength(2);
    expect(wrap('a '.repeat(200), 10, 2)[1].endsWith('…')).toBe(true);
  });
});

describe('Poncho set art', () => {
  it('uses the Poncho Pals vector style: one distinct, well-formed picture per card', () => {
    const ids = [41, 42, 43, 44, 45, 46, 47, 48, 1002];
    const svgs = ids.map((id) => ponchoSvg(id));
    expect(new Set(svgs).size).toBe(ids.length);
    for (const [i, svg] of svgs.entries()) {
      expect(svg.startsWith('<svg')).toBe(true);
      if (PONCHO_IMAGES[ids[i]]) expect(svg).toContain('<image href="data:image/');
      else expect(svg).toContain('#1e1440'); // vector pal: thick navy outline
      expect(svg).not.toMatch(/<[^>]*\bstroke-width="[^"]*"[^>]*\bstroke-width=/); // no duplicate attributes (invalid XML)
    }
    expect(spriteSvg(48)).toBe(ponchoSvg(48)); // the web and metadata use the same art
    expect(ponchoArt(34)).toBeNull(); // core cards stay pixel art
  });
  it('embeds every generated image in assets/poncho (run pnpm art:poncho-images after adding one)', () => {
    const files = readdirSync(new URL('../assets/poncho', import.meta.url)).filter((f) => /^\d+\.(jpe?g|png)$/i.test(f));
    expect(Object.keys(PONCHO_IMAGES).map(Number).sort()).toEqual(files.map((f) => Number(f.split('.')[0])).sort());
    expect(cardSvg(48)).toContain('PB');
  });
  it('uses the Poncho palette, serape frame and set label', () => {
    expect(paletteFor(CARDS.find((c) => c.id === 48)!)).toBe(PONCHO_PALETTE);
    expect(paletteFor(CARDS.find((c) => c.id === 34)!)).toBe(PALETTES.neutral);
    const svg = cardSvg(48);
    expect(svg).toContain('PONCHO SET');
    expect(svg).toContain('Poncho collab set');
    expect(cardSvg(34)).not.toContain('PONCHO');
  });
});

describe('ERC-1155 metadata', () => {
  it('uses the {id} hex form and parses both forms', () => {
    expect(erc1155IdHex(10032)).toBe('0'.repeat(60) + '2730');
    expect(parseTokenId(erc1155IdHex(12) + '.json')).toBe(12);
    expect(parseTokenId('10012.json')).toBe(10012);
    expect(parseTokenId(String(STARTER_OFFSET + 8))).toBeNull(); // no Legendary starter copies
    expect(parseTokenId('48')).toBe(48); // Poncho
    expect(parseTokenId(String(STARTER_OFFSET + 41))).toBeNull(); // collab cards have no starter copies
    expect(parseTokenId(String(Math.max(...COLLECTIBLE.map((c) => c.id)) + 1))).toBeNull(); // past the last card
    expect(parseTokenId('1000')).toBeNull(); // tokens (Drone) are never minted
  });
  it('describes every token with attributes, and starter copies as soulbound', () => {
    // Every card, its soulbound starter copy (the 36 starter cards), and its foil.
    expect(tokenIds()).toHaveLength(COLLECTIBLE.length + 36 + COLLECTIBLE.length);
    const f = cardMetadata(20_008);
    expect(f.name).toBe('The Launcher (Foil)');
    expect(f.attributes).toEqual(expect.arrayContaining([{ trait_type: 'Edition', value: 'Foil' }]));
    expect(f.properties.foil).toBe(true);
    expect(parseTokenId(erc1155IdHex(20_041) + '.json')).toBe(20_041);
    expect(cardSvg(8, { foil: true })).toContain('✦ FOIL');
    const p = cardMetadata(48);
    expect(p.name).toBe('Poncho, Cutest Cat on Base');
    expect(p.attributes).toEqual(expect.arrayContaining([{ trait_type: 'Set', value: 'Poncho (collab)' }, { trait_type: 'Chain of origin', value: 'Base' }]));
    expect(p.description).toContain('@ponchobase');
    const m = cardMetadata(24);
    expect(m.name).toBe('The Whale');
    expect(m.image.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(m.attributes).toEqual(expect.arrayContaining([
      { trait_type: 'Race', value: 'Brokers' }, { trait_type: 'Rarity', value: 'Legendary' },
      { trait_type: 'Attack', value: 6, display_type: 'number' }, { trait_type: 'Keyword', value: 'Hold' },
    ]));
    const s = cardMetadata(STARTER_OFFSET + 17, { imageBase: 'https://x/metadata/images', appUrl: 'https://x' });
    expect(s).toMatchObject({ name: 'Intern (Starter)', image: 'https://x/metadata/images/10017.svg', external_url: 'https://x/collection' });
    expect(s.properties.soulbound).toBe(true);
    expect(collectionMetadata().name).toContain('Forkfall');
  });
});
