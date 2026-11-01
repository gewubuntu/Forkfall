// Fails when Claude's setup drifts from the repo: CLAUDE.md and .claude/**/*.md naming a path, `pnpm <script>` or GDD
// heading that doesn't exist, steward's CI table missing a ci.yml job, or the hooks breaking.
// Usage: node scripts/check-agent-setup.mjs [repoRoot]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const root = process.argv[2] ?? process.cwd();
const read = (f) => readFileSync(join(root, f), 'utf8');
// Tracked plus new, not-ignored files: the same answer locally and in CI, and never .claude/worktrees/ or node_modules.
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean);
const docs = files.filter((f) => f === 'CLAUDE.md' || (f.startsWith('.claude/') && f.endsWith('.md')));
const names = new Set(files.map((f) => basename(f)));
const tops = new Set(files.map((f) => f.split('/')[0]));
const exists = (p) => files.some((f) => f === p.replace(/\/$/, '') || f.startsWith(p.replace(/\/?$/, '/')));
const scripts = JSON.parse(read('package.json')).scripts ?? {};
// Files the docs name on purpose although they don't exist in a clean checkout.
const MADE_AT_RUNTIME = new Set(['qa-probe.test.ts', 'qa-probe.spec.ts', 'QaProbe.t.sol', '31337.json', 'apps/server/data/']);
const PNPM_BUILTINS = new Set(['install', 'i', 'add', 'remove', 'update', 'up', 'dedupe', 'exec', 'dlx', 'run', 'why', 'list',
  'ls', 'store', 'outdated', 'audit', 'rebuild', 'config', 'patch', 'approve-builds', 'licenses', 'prune', 'peers', 'view']);
const EXT = /\.(ts|tsx|mjs|js|sol|md|json|sh|yml|yaml|toml|css|html)$/;
const problems = [];

for (const doc of docs) {
  for (const [, span] of read(doc).matchAll(/`([^`\n]+)`/g)) {
    for (const [, s] of span.matchAll(/(?:^|\s)pnpm (?:run )?([a-z][\w:-]*)/g)) {
      if (!PNPM_BUILTINS.has(s) && !(s in scripts)) problems.push(`${doc}: \`pnpm ${s}\` is not a package.json script`);
    }
    const p = span.replace(/:\d+(-\d+)?$/, '').replace(/[.,;)]+$/, '');
    if (/[\s<>$*…{}~|=#]/.test(p) || /^(\/|https?:|\.\.?\/|\.[^/]*$)|\/\.env/.test(p)) continue;
    if (MADE_AT_RUNTIME.has(p) || MADE_AT_RUNTIME.has(basename(p))) continue;
    if (p.includes('/')) {
      // Only spans that look like repo paths: a top-level entry first, or a file extension last. Branch names,
      // package names (@forkfall/web), owner/repo and time zones are neither.
      if (/^[\w@.-]+(\/[\w@.-]+)+\/?$/.test(p) && (tops.has(p.split('/')[0]) || EXT.test(p)) && !exists(p)) {
        problems.push(`${doc}: path \`${p}\` does not exist`);
      }
    } else if (EXT.test(p) && !names.has(p)) {
      problems.push(`${doc}: no tracked file is named \`${p}\``);
    }
  }
}

// qa-explorer's area table: every GDD heading it names (column 3, ';'-separated) must be a heading in the GDD.
const qa = '.claude/skills/qa-explorer/SKILL.md';
if (existsSync(join(root, qa))) {
  const gdd = new Set(read('docs/GDD-v0.1.md').split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => l.replace(/^#+\s*/, '').trim()));
  const rows = read(qa).split('\n').filter((l) => /^\| \d+ \|/.test(l));
  if (!rows.length) problems.push('qa-explorer area table: no `| <n> |` rows found, so no GDD heading was checked');
  for (const row of rows) {
    for (const h of row.split('|')[3].split(';').map((s) => s.trim()).filter(Boolean)) {
      if (!gdd.has(h)) problems.push(`qa-explorer area table: GDD heading "${h}" not found`);
    }
  }
}

// steward's CI table has exactly one row per ci.yml job.
const steward = '.claude/skills/steward/SKILL.md';
if (existsSync(join(root, steward))) {
  const ci = read('.github/workflows/ci.yml').split('\n');
  const jobs = ci.slice(ci.indexOf('jobs:') + 1).map((l) => l.match(/^ {2}([\w-]+):\s*$/)?.[1]).filter(Boolean);
  const rows = new Set([...read(steward).matchAll(/^\| `([\w-]+)` \|/gm)].map((m) => m[1]));
  for (const j of jobs) if (!rows.has(j)) problems.push(`${steward}: no CI table row for ci.yml job \`${j}\``);
  for (const r of rows) if (!jobs.includes(r)) problems.push(`${steward}: CI table row \`${r}\` is not a ci.yml job`);
}

// Hooks: settings.json parses and points at existing scripts, both scripts parse, and the PR reminder is valid JSON.
const settings = JSON.parse(read('.claude/settings.json'));
for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
  for (const h of entries.flatMap((e) => e.hooks)) {
    const script = h.command.match(/\.claude\/hooks\/[\w.-]+/)?.[0];
    if (script && !existsSync(join(root, script))) problems.push(`settings.json ${event} hook: ${script} does not exist`);
  }
}
const run = (cmd, args, input) => execFileSync(cmd, args, { cwd: root, input, encoding: 'utf8' });
for (const [shell, f] of [['bash', '.claude/hooks/session-start.sh'], ['sh', '.claude/hooks/pr-opened.sh']]) {
  try { run(shell, ['-n', f]); } catch (e) { problems.push(`${f}: ${shell} -n failed: ${e.message.split('\n')[0]}`); }
}
try {
  const payload = JSON.stringify({ tool_response: [{ type: 'text', text: '{"url":"https://github.com/o/r/pull/7"}' }] });
  const ctx = JSON.parse(run('sh', ['.claude/hooks/pr-opened.sh'], payload)).hookSpecificOutput.additionalContext;
  if (!ctx.includes('code-reviewer')) problems.push('pr-opened.sh: the reminder no longer names the code-reviewer agent');
} catch (e) {
  problems.push(`pr-opened.sh: no valid PostToolUse JSON (${e.message.split('\n')[0]})`);
}

if (problems.length) {
  console.error(`Claude's setup drifted from the repo (fix the doc, or the allowlist in scripts/check-agent-setup.mjs):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`agent setup OK (${docs.length} docs, hooks)`);
