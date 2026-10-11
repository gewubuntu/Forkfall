/**
 * Lighthouse budget for phones (CI job `lighthouse`, or locally `pnpm web:lighthouse` against a running referee that
 * serves the built web app). Each page is measured RUNS times with Lighthouse's mobile preset (simulated slow 4G,
 * 4× CPU slowdown) and judged on the median, because one run swings by ±0.04 on the same build.
 *
 * Blocking: a median performance score under FLOOR, or a median layout shift above MAX_CLS (any real shift, such as a
 * header or banner moving, is well above it; a web font swapping in nudges the board by under 0.001). The 0.85 target
 * from the mobile work is reported next to it but does not fail the job: on CI-sized machines a page that meets it
 * measures 0.81–0.88.
 *
 * Env: BASE_URL (default http://127.0.0.1:8787), CHROME_PATH (Chrome or Chromium), LIGHTHOUSE (CLI command,
 * default `npx -y lighthouse@13.5.0`), RUNS (default 3), GITHUB_STEP_SUMMARY (a Markdown table is appended there).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PAGES = [
  { path: '/', name: 'Landing' },
  { path: '/learn/basics', name: 'Tutorial board' },
];
export const FLOOR = 0.8;
export const TARGET = 0.85;
export const MAX_CLS = 0.01;

export interface Run { score: number; lcpMs: number; tbtMs: number; cls: number; bytes: number }
export interface Verdict { name: string; path: string; score: number; lcpMs: number; tbtMs: number; cls: number; bytes: number; ok: boolean; reasons: string[] }

export function median(xs: number[]): number {
  if (!xs.length) throw new Error('median of no runs');
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The fields this budget reads from a Lighthouse JSON report. */
export function readRun(report: { categories: { performance: { score: number | null } }; audits: Record<string, { numericValue?: number }> }): Run {
  const a = report.audits;
  const n = (id: string) => a[id]?.numericValue ?? NaN;
  return {
    score: report.categories.performance.score ?? 0,
    lcpMs: n('largest-contentful-paint'), tbtMs: n('total-blocking-time'), cls: n('cumulative-layout-shift'), bytes: n('total-byte-weight'),
  };
}

export function judge(page: { path: string; name: string }, runs: Run[], floor = FLOOR): Verdict {
  const m = (k: keyof Run) => median(runs.map((r) => r[k]));
  const v = { ...page, score: m('score'), lcpMs: m('lcpMs'), tbtMs: m('tbtMs'), cls: m('cls'), bytes: m('bytes') };
  const reasons: string[] = [];
  if (!(v.score >= floor)) reasons.push(`performance ${pct(v.score)} is under the floor of ${pct(floor)}`);
  if (!(v.cls <= MAX_CLS)) reasons.push(`layout shift ${v.cls.toFixed(3)} is over ${MAX_CLS}`);
  return { ...v, ok: reasons.length === 0, reasons };
}

const pct = (x: number) => Math.round(x * 100).toString();

export function summary(verdicts: Verdict[], runs: number): string {
  const rows = verdicts.map((v) => `| ${v.name} (\`${v.path}\`) | **${pct(v.score)}**${v.score >= TARGET ? '' : ' (under target)'} | ${(v.lcpMs / 1000).toFixed(1)} s | ${Math.round(v.tbtMs)} ms | ${v.cls.toFixed(3)} | ${Math.round(v.bytes / 1024)} KiB | ${v.ok ? '✓' : `✗ ${v.reasons.join('; ')}`} |`);
  return [
    `### Lighthouse, mobile (median of ${runs} runs)`,
    '',
    `Fails under ${pct(FLOOR)} or on a layout shift over ${MAX_CLS}; the target is ${pct(TARGET)}.`,
    '',
    '| Page | Performance | LCP | TBT | CLS | Transferred | |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

if (import.meta.main) {
  const base = (process.env.BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
  const runs = Number(process.env.RUNS ?? 3);
  const [cmd, ...pre] = (process.env.LIGHTHOUSE ?? 'npx -y lighthouse@13.5.0').split(' ');
  const out = mkdtempSync(join(tmpdir(), 'forkfall-lh-'));
  const verdicts = PAGES.map((page) => {
    const results = Array.from({ length: runs }, (_, i) => {
      const file = join(out, `${page.name.replace(/\W+/g, '-')}-${i}.json`);
      execFileSync(cmd, [...pre, base + page.path, '--quiet', '--only-categories=performance', '--output=json', `--output-path=${file}`,
        '--chrome-flags=--headless=new --no-sandbox'], { stdio: ['ignore', 'ignore', 'inherit'] });
      const r = readRun(JSON.parse(readFileSync(file, 'utf8')));
      console.log(`${page.path} run ${i + 1}: ${pct(r.score)} · LCP ${(r.lcpMs / 1000).toFixed(1)} s · TBT ${Math.round(r.tbtMs)} ms · CLS ${r.cls.toFixed(3)}`);
      return r;
    });
    return judge(page, results);
  });
  const md = summary(verdicts, runs);
  console.log(`\n${md}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  if (verdicts.some((v) => !v.ok)) process.exit(1);
}
