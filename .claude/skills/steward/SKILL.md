---
name: steward
description: How to drive a Forkfall pull request to mergeable — which CI checks exist and how to reproduce each locally, generated and synced files, what to fix yourself and when to stop and ask the owner. Read before opening or babysitting a Forkfall PR, pushing a fix for red CI, answering review comments, or calling a PR done.
---

# Driving a Forkfall PR to green

The owner merges (the one exception is in CLAUDE.md, Never). Your job ends at a PR that is green, conflict-free, reviewed (CLAUDE.md) and described accurately.

## CI checks (`.github/workflows/ci.yml`) and how to reproduce them

The SessionStart hook (`.claude/hooks/session-start.sh`) puts Node, pnpm and Foundry (`forge`, `anvil`) on PATH in
cloud sessions; forge finds solc in `~/.svm`. Reproduce a failure locally before pushing a fix, then show the same
command passing. CI runs for pull requests and `main` only: a branch without a PR gets no checks, and a newer push
cancels the PR's previous run. After each push, follow CI on the new head SHA to the end (`subscribe_pr_activity`
in an interactive cloud session; a scheduled run polls `pull_request_read` `get_check_runs` instead of ending on a
subscription); results for an older SHA don't count.

| Check | Local command |
| --- | --- |
| `typescript` | `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm sim 500 poncho && pnpm web:build && node scripts/check-agent-setup.mjs` |
| `web-e2e` | `pnpm web:build && PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e` (as CI; Playwright's own pinned browser isn't in the cloud image). It starts a referee on :4317 and Vite on :4319: if your own earlier run still holds them, free them with `fuser -k 4317/tcp 4319/tcp` (exit 1 means already free); one run at a time |
| `lighthouse` | `pnpm web:build`, start the referee (`OFFCHAIN=1 PORT=8787 MATCH_ARCHIVE_DIR=$(mktemp -d) node --import tsx apps/server/src/main.ts &`) and wait until `curl -fs localhost:8787/v1/config` answers, then `CHROME_PATH=/usr/bin/google-chrome RUNS=5 BASE_URL=http://127.0.0.1:8787 pnpm web:lighthouse`, then stop the referee by PID (budgets: `PAGES`, `FLOOR`, `MAX_CLS` in `apps/web/lighthouse.ts`) |
| `contracts` | `cd contracts && forge fmt --check && forge build --sizes && forge test -vv`, then `pnpm test:abi` from the root |
| `docker` | `docker build -f deploy/Dockerfile -t forkfall-referee .` plus the off-chain smoke run in ci.yml (cloud sessions have no Docker daemon: rely on the CI job and say so) |

`pnpm sim 500 poncho` is a balance gate from the GDD (every race 45–55 %, Poncho set ≤ 58 %). A red sim means a
balance problem in the change, not a flake: report it to the owner rather than tuning numbers to pass.

When a command here fails for a reason that isn't the PR, fix the line in the same PR.

## Generated and synced files

- Cards: edit `packages/engine/src/cards.ts`, then `pnpm gen:cards` (writes `contracts/src/generated/Set1Cards.sol`;
  `packages/engine/test/solidity-sync.test.ts` fails until you do).
- Rules versions: a change to how a card plays fails `packages/engine/test/rules.test.ts` until you merge
  `origin/main`, run `pnpm rules:bump` once and pin the fingerprint it prints in `SHIPPED` there. Text-only edits
  need no bump. A change to the engine's own logic has no table to diff: gate it on `g.rules` by hand (README,
  "Rules versions").
- ABIs: `packages/sdk/src/abis.ts` is hand-written; after `cd contracts && forge build`, `pnpm test:abi` compares it
  with the built contracts. Edit it to match.
- Lockfile: `pnpm install` (never edit `pnpm-lock.yaml` by hand).

## Fix yourself

Red CI caused by the PR, merge conflicts (merge `origin/main` in; never rebase or force-push a branch with an open PR),
reviewer nits and small asks, missing tests, a stale PR description, a GDD line the change made wrong.

## Stop and ask the owner

- Anything that would contradict `docs/GDD-v0.1.md` (CLAUDE.md, "Keep the GDD in sync").
- Checks that fail within seconds with "The job was not started…" (billing or spending limit), or never start: CI
  didn't run. Say so in the PR description and to the owner; don't call it green or treat it as a code failure.
- Contract changes that alter storage layout, an external function or an event: live deployments can't be upgraded
  in place, so these need a redeploy plan.
- A failing balance gate (`pnpm sim`).
- A failure you can't reproduce, or one that is red on `main` too (say so on the PR, with the failing check).

## Never

CLAUDE.md's Never list applies. Also: no empty commits to re-run CI.
