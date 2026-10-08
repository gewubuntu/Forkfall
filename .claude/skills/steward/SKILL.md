---
name: steward
description: How to drive a Forkfall pull request to mergeable — which CI checks exist and how to reproduce each locally, how to regenerate generated files, what to fix yourself and when to stop and ask the owner. Use when opening, babysitting or fixing CI and review comments on a Forkfall PR.
---

# Driving a Forkfall PR to green

The owner merges. Your job ends at a PR that is green, conflict-free, reviewed (CLAUDE.md) and described accurately.

## CI checks (`.github/workflows/ci.yml`) and how to reproduce them

The SessionStart hook (`.claude/hooks/session-start.sh`) puts Node 26, pnpm, `forge` and solc on PATH in cloud
sessions. Reproduce a failure locally before pushing a fix, then show the same command passing.

| Check | Local command |
| --- | --- |
| `typescript` | `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm sim 500 poncho && pnpm web:build` |
| `web-e2e` | `pnpm web:build && pnpm test:e2e` (off-chain referee; Chromium is at `/opt/pw-browsers`) |
| `contracts` | `cd contracts && forge fmt --check && forge build --sizes && forge test -vv`, then `pnpm test:abi` from the root |
| `docker` | `docker build -f deploy/Dockerfile -t forkfall-referee .` plus the off-chain smoke run in ci.yml (when Docker is available) |

`pnpm sim 500 poncho` is a balance gate from the GDD (every race 45–55 %, Poncho set ≤ 58 %). A red sim means a
balance problem in the change, not a flake: report it to the owner rather than tuning numbers to pass.

## Generated files: regenerate, never hand-edit

- Cards: edit `packages/engine/src/cards.ts`, then `pnpm gen:cards` (writes `contracts/src/generated/Set1Cards.sol`).
- Rules versions: a change to how a card plays fails the fingerprint test until `pnpm rules:bump` is run once in the
  PR (README, "Rules versions"). Text-only edits need no bump.
- ABIs: `pnpm test:abi` compares `packages/sdk` ABIs with the built contracts; update the SDK ABI to match.
- Lockfile: `pnpm install` (never edit `pnpm-lock.yaml` by hand).

## Fix yourself

Red CI caused by the PR, merge conflicts (merge `origin/main` in; no rebase or force-push on someone else's branch),
reviewer nits and small asks, missing tests, a stale PR description, a GDD line the change made wrong.

## Stop and ask the owner

- Anything that would contradict `docs/GDD-v0.1.md` (rules, cards, economy, odds, quests, timers, scope).
- Contract changes that alter storage layout, an external function or an event: live deployments can't be upgraded
  in place, so these need a redeploy plan.
- A failing balance gate (`pnpm sim`).
- A failure you can't reproduce, or one that is red on `main` too (say so on the PR, with the failing check).

## Never

- Deploy contracts, run anything with `--broadcast`, or edit `contracts/deployments/*.json` (only a real deploy writes it).
- Read, print or commit keys or `.env` files; never put an RPC URL with an API key in a commit, log or PR text.
- Point anything at a mainnet chain id or RPC.
- Skip, disable or loosen a test to get green; push empty commits; merge or approve your own PR.
