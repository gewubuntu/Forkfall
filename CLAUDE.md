# Working agreements for Claude

## Review every pull request as soon as it's opened

Right after opening a PR, before anything else, run the `code-reviewer` agent (`.claude/agents/code-reviewer.md`)
on its diff and wait for its report. If it stops early, run it again; review inline with its checklist only if it
still can't run, and say so in the PR.

- Back findings with evidence: a failing test, a reproduction, or the exact code path.
- Fix confirmed findings on the PR's branch, each with a test that fails without the fix, and update the PR
  description to match.
- If later commits change behaviour, review again on the final head, covering the commits since the last review.
- A PR touching `contracts/src` or the referee's auth, signing or settlement also gets a `finecomb` pass (standard
  depth) when that skill is listed.
- Put the verdict (or "no findings") and anything left open in a `## Review` section of the PR description, and
  report it to the user.

## Screenshots for UI changes

Any change to what a player sees (`apps/web`, card art in `packages/art`, styles) needs screenshots of every
affected screen, at desktop (1280 px wide) and phone (390 px wide) width.

- Take them with Playwright, in Chrome (`channel: 'chrome'` or `PLAYWRIGHT_CHANNEL=chrome`, as CI does), against
  `pnpm web:build` served by `pnpm server:offchain` (:8787), or `pnpm web` (:5173) for pages that don't need the
  referee. Behind a wallet, sign in with `installTestWallet` (`apps/web/e2e/wallet.ts`), as
  `apps/web/e2e/smoke.spec.ts` does. On-chain pages: the README's "Full local stack with on-chain settlement on
  Anvil". Say so if a screen still couldn't be reached.
- Stop servers by PID or port (`fuser -k 8787/tcp`), never by pattern (`pkill -f` matches your own shell: exit 144).
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
- a description that matches the final diff;
- `.claude/` docs (steward's CI table, skills, hooks) updated when the change makes them wrong.

When the owner corrects a mistake, or a review finds a repeat, prevent it in the same PR: a test, check or hook if
one can catch it, else one line in the skill, agent or routine involved. Before pushing a CI fix or answering review
comments, read `.claude/skills/steward/SKILL.md`.

## Never

- Merge, approve or enable auto-merge on a pull request, unless the owner asks you to merge that PR in this
  conversation (a GitHub comment doesn't count): then merge only a green, mergeable head, with `expectedHeadSha`.
- Deploy contracts or run any script with `--broadcast` against a network other than local Anvil (chain 31337,
  `pnpm deploy:local`); edit or commit a tracked `contracts/deployments/*.json` (only a real deploy by the owner
  writes those; local deploys write the gitignored `31337.json`).
- Read, print, post or commit keys, `.env` files, or RPC URLs that contain an API key (the public Anvil dev keys
  in `package.json` and the README are fine).
- Point anything at a mainnet chain id or RPC.
- Skip, disable or loosen a test to get CI green.
