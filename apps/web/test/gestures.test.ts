import { describe, expect, it } from 'vitest';
import { classifyGesture, DRAG_SLOP_PX, LONG_PRESS_MS } from '../src/game/gestures.ts';

describe('board gestures', () => {
  it('a quick touch is a tap (tap-to-select / tap-to-play)', () => {
    expect(classifyGesture(2, 3, 120, 'touch')).toBe('tap');
  });
  it('a held, still touch is a long-press (card details), never a play', () => {
    expect(classifyGesture(3, 1, LONG_PRESS_MS, 'touch')).toBe('long');
    expect(classifyGesture(0, 0, LONG_PRESS_MS + 500, 'pen')).toBe('long');
  });
  it('the mouse has no long-press (it has hover)', () => {
    expect(classifyGesture(0, 0, 2000, 'mouse')).toBe('tap');
  });
  it('moving past the slop is a drag, however long it was held', () => {
    expect(classifyGesture(DRAG_SLOP_PX + 1, 0, 50, 'touch')).toBe('drag');
    expect(classifyGesture(0, -40, LONG_PRESS_MS * 3, 'touch')).toBe('drag');
    expect(classifyGesture(DRAG_SLOP_PX - 1, 0, 50, 'touch')).toBe('tap');
  });
});
