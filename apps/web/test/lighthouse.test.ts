import { describe, expect, it } from 'vitest';
import { FLOOR, judge, median, PAGES, readRun, summary, type Run } from '../lighthouse.ts';

const run = (score: number, cls = 0): Run => ({ score, lcpMs: 3400, tbtMs: 60, cls, bytes: 360 * 1024 });
const page = { path: '/', name: 'Landing' };

describe('Lighthouse budget', () => {
  it('judges the median run, so one slow run does not fail a good page', () => {
    expect(median([0.86, 0.71, 0.88])).toBe(0.86);
    expect(median([0.8, 0.9])).toBeCloseTo(0.85);
    expect(judge(page, [run(0.86), run(0.71), run(0.88)]).ok).toBe(true);
  });

  it('holds a page to its own floor when it sets one', () => {
    const tutorial = { path: '/learn/basics', name: 'Tutorial board', floor: 0.9 };
    expect(judge(tutorial, [run(0.86), run(0.88), run(0.95)]).ok).toBe(false);   // fine for the landing page, not here
    expect(judge(tutorial, [run(0.86), run(0.91), run(0.95)]).ok).toBe(true);
    expect(judge(page, [run(0.86), run(0.88), run(0.95)]).ok).toBe(true);
    expect(PAGES.find((p) => p.path === '/learn/basics')?.floor).toBe(0.9);
  });

  it('fails a page whose median is under the floor', () => {
    const v = judge(page, [run(0.6), run(0.79), run(0.86)]);
    expect(v.ok).toBe(false);
    expect(v.score).toBeLessThan(FLOOR);
    expect(v.reasons.join()).toMatch(/under the floor/);
  });

  it('fails on a layout shift, even with a good score, but not on one odd run or font-swap jitter', () => {
    const v = judge(page, [run(0.9, 0.05), run(0.9, 0.12), run(0.9)]);
    expect(v.ok).toBe(false);
    expect(v.reasons.join()).toMatch(/layout shift/);
    expect(judge(page, [run(0.9, 0.0008), run(0.9, 0.013), run(0.9, 0.0008)]).ok).toBe(true);
  });

  it('reads a Lighthouse report, and treats a missing score as 0', () => {
    const audits = {
      'largest-contentful-paint': { numericValue: 3100 }, 'total-blocking-time': { numericValue: 40 },
      'cumulative-layout-shift': { numericValue: 0 }, 'total-byte-weight': { numericValue: 365_000 },
    };
    expect(readRun({ categories: { performance: { score: 0.87 } }, audits })).toEqual({ score: 0.87, lcpMs: 3100, tbtMs: 40, cls: 0, bytes: 365_000 });
    expect(readRun({ categories: { performance: { score: null } }, audits }).score).toBe(0);
    // An audit Lighthouse could not run makes the run fail the CLS check rather than pass silently.
    expect(judge(page, [readRun({ categories: { performance: { score: 0.9 } }, audits: {} })]).ok).toBe(false);
  });

  it('marks pages under the 85 target in the summary without failing them', () => {
    const md = summary([judge(page, [run(0.82)])], 1);
    expect(md).toContain('**82** (under target)');
    expect(md).toContain('✓');
  });
});
