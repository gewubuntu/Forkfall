import { describe, expect, it } from 'vitest';
import { PONCHO_IMAGES as EMBEDDED } from '../../../packages/art/src/ponchoImages.ts';
import { PONCHO_IMAGES } from '../src/lib/ponchoImages.web.ts';
import { withPonchoArtwork } from '../src/lib/sharePull.ts';

describe('share image artwork', () => {
  it('loads the embedded Poncho artwork only for a pull that has a Poncho card', async () => {
    await withPonchoArtwork([1, 2, 3, 4, 5]);
    expect(Object.keys(PONCHO_IMAGES)).toEqual([]); // core cards: nothing fetched
    await withPonchoArtwork([1, 2, 48, 4, 5]);
    expect(Object.keys(PONCHO_IMAGES).sort()).toEqual(Object.keys(EMBEDDED).sort());
    expect(PONCHO_IMAGES[48]).toMatch(/^data:image\//);
  });
});
