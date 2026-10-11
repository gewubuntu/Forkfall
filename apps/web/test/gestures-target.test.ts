import { describe, expect, it } from 'vitest';
import { targetFromElement } from '../src/game/gestures.ts';

/** A stand-in DOM node: `closest` walks a list of (selector-match, dataset) ancestors, nearest first. */
type Node = { cls: string[]; data?: Record<string, string> };
function el(...chain: Node[]): Element {
  const at = (i: number): Element => ({
    dataset: chain[i]?.data ?? {},
    closest(sel: string) {
      for (let j = i; j < chain.length; j++) {
        const n = chain[j];
        const hit = sel.split(',').map((x) => x.trim()).some((one) => {
          const attr = /^\[data-(\w+)\]$/.exec(one);
          if (attr) return !!n.data?.[attr[1]];
          return one.split('.').filter(Boolean).every((c) => n.cls.includes(c));
        });
        if (hit) return at(j);
      }
      return null;
    },
  }) as unknown as Element;
  return at(0);
}

describe('drop targets', () => {
  it('a drop over the hand is a cancel, never a play (even onto the card itself)', () => {
    expect(targetFromElement(el({ cls: ['gcard'], data: { hand: '7', zoom: '3' } }, { cls: ['hand'] }, { cls: ['arena'] }))).toBeNull();
    expect(targetFromElement(el({ cls: ['hand'] }, { cls: ['arena'] }))).toBeNull();
  });
  it('your own lane is the board; units and Treasuries are targets', () => {
    expect(targetFromElement(el({ cls: ['lane'] }, { cls: ['side', 'me'] }))).toEqual({ kind: 'board' });
    expect(targetFromElement(el({ cls: ['gcard'], data: { uid: '12' } }, { cls: ['lane'] }, { cls: ['side', 'opp'] }))).toEqual({ kind: 'unit', uid: 12 });
    expect(targetFromElement(el({ cls: ['t-val'] }, { cls: ['treasury'], data: { treasury: '1' } }, { cls: ['side', 'opp'] }))).toEqual({ kind: 'treasury', side: 1 });
  });
  it('outside the board is nothing', () => {
    expect(targetFromElement(el({ cls: ['turnbar'] }, { cls: ['arena'] }))).toBeNull();
    expect(targetFromElement(null)).toBeNull();
  });
});
