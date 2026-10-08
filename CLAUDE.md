# Working agreements for Claude

These apply to every session in this repository.

## Review every pull request as soon as it's opened

Right after opening a PR, review its diff before doing anything else. Use the `code-reviewer` agent
(`.claude/agents/code-reviewer.md`) or the same checklist directly: correctness, rule/engine regressions,
referee and contract security, missing tests.

- Back findings with evidence: a failing test, a reproduction, or the exact code path.
- Fix confirmed findings on the PR's branch, each with a test that fails without the fix, and update the PR
  description to match.
- Report the verdict and anything left open to the user.

A `PostToolUse` hook in `.claude/settings.json` reminds you when `create_pull_request` succeeds.

## Screenshots for UI changes

Any change to what a player sees (`apps/web`, card art in `packages/art`, styles) needs screenshots of every
affected screen, at desktop (1280 px wide) and phone (390 px wide) width.

- Take them with Playwright against `pnpm web:build` served by `pnpm server:offchain`, or `pnpm web` for pages
  that don't need the referee. For pages behind a wallet, sign in with the test wallet in
  `apps/web/e2e/wallet.ts` (`installTestWallet`), as `apps/web/e2e/smoke.spec.ts` does; say so if a screen
  still couldn't be reached (on-chain pages need a deployment).
- Before and after when the change alters an existing screen.
- Send them to the user and list what each one shows in the PR description. Don't commit screenshots to the
  repository.

## Keep the GDD in sync

`docs/GDD-v0.1.md` is the design source of truth. When a change alters something it describes (rules, cards,
races, packs and odds, quests and rewards, the economy and token, matchmaking and timers, the referee and
on-chain architecture, the MVP scope or roadmap), update the GDD in the same PR and say what changed in the PR
description. If a change would contradict a design decision in the GDD, ask the user before making it.

## Definition of done

A change is done when its PR has:

- tests that fail without the change (or screenshots, for what a player sees);
- the GDD updated in the same PR when the change touches what it describes;
- the review above done, its confirmed findings fixed;
- CI green on the latest commit and no merge conflict;
- a description that matches the final diff.

`.claude/skills/steward/SKILL.md` says how to reproduce each CI check and when to stop and ask.

## Never

- Merge or approve a pull request: the owner merges.
- Deploy contracts or run any script with `--broadcast`; edit `contracts/deployments/*.json` by hand.
- Read, print or commit keys, `.env` files, or RPC URLs that contain an API key.
- Point anything at a mainnet chain id or RPC.
- Skip, disable or loosen a test to get CI green.
