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
  that don't need the referee. Pages behind a wallet need a test wallet or a stubbed session; say so if a
  screen couldn't be reached.
- Before and after when the change alters an existing screen.
- Send them to the user and list what each one shows in the PR description. Don't commit screenshots to the
  repository.

## Keep the GDD in sync

`docs/GDD-v0.1.md` is the design source of truth. When a change alters something it describes (rules, cards,
races, packs and odds, quests and rewards, the economy and token, matchmaking and timers, the referee and
on-chain architecture, the MVP scope or roadmap), update the GDD in the same PR and say what changed in the PR
description. If a change would contradict a design decision in the GDD, ask the user before making it.
