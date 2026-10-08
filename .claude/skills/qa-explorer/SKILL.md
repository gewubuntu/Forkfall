---
name: qa-explorer
description: Test one area of the Forkfall GDD (docs/GDD-v0.1.md) against the running game and file GitHub issues, with reproductions, for what doesn't match. Use for scheduled QA runs ("run the qa-explorer skill for today's area") or when asked to check whether a GDD section is implemented as written.
---

# QA explorer: does the game do what the GDD says?

One run tests **one area** deeply. It never fixes anything: it finds mismatches, proves them, and files issues.
Follow `CLAUDE.md`, especially **Never**.

## 1. Pick the area

Unless the prompt names an area, take `areas[dayOfYear(UTC) % 13]` (day of year starting at 1). The GDD headings are
the source of truth; read the whole section, not only the bullets.

| # | Area | GDD heading | Code to read | Best harness |
| --- | --- | --- | --- | --- |
| 0 | Match rules | Core game loop & match rules | `packages/engine/src/engine.ts`, `apps/server/src/lobby/matchmaking.ts` | engine probe, referee |
| 1 | Cards & deck rules | Cards & collection | `packages/engine/src/cards.ts`, `deckcode.ts` | engine probe, browser (`deckcodes.spec.ts`) |
| 2 | Packs and pity | Pack incentives without pay-to-win | `contracts/src/PackSale.sol`, `Crafting.sol` | Anvil |
| 3 | Friend challenges | Friend challenges | `apps/server/src/lobby/challenges.ts` | referee, browser |
| 4 | Pack randomness | Pack randomness (Chainlink VRF) | `contracts/src/PackSale.sol`, `contracts/src/vrf/` | forge tests, Anvil |
| 5 | Daily quests | Daily quests and free packs | `packages/engine/src/quests.ts`, `apps/server/src/quests.ts` | engine probe, referee |
| 6 | Season pass | Season pass | `packages/engine/src/pass.ts`, `contracts/src/SeasonPass.sol` | engine probe, referee |
| 7 | Sealed | Sealed events | `packages/engine/src/sealed.ts`, `apps/server/src/sealed.ts` | referee, browser (`sealed.spec.ts`) |
| 8 | Gifts & referrals | Gifts and referrals | `packages/engine/src/referrals.ts`, `apps/server/src/invites.ts`, `contracts/src/PackGifts.sol` | referee, Anvil |
| 9 | Alpha metrics | Alpha metrics | `apps/server/src/metrics.ts` | referee, browser (`metrics.spec.ts`) |
| 10 | Onboarding & cosmetics | Onboarding and cosmetics | `packages/engine/src/tutorial.ts`, `cosmetics.ts`, `apps/server/src/profiles.ts` | browser (`smoke.spec.ts`) |
| 11 | Humans & agents | Humans & agents (+ Human queue) | `apps/server/src/humans.ts`, `auth.ts`, `contracts/src/AgentRegistry.sol` | referee, Anvil |
| 12 | On-chain settlement & league | On-chain architecture, Agent League economics | `contracts/src/MatchSettlement.sol`, `AgentLeague.sol`, `apps/server/src/league.ts` | Anvil |

## 2. Turn the section into checks

List every concrete, checkable statement: numbers, limits, timers, odds, caps, who may do what, what happens on
failure. Skip vision, pricing and legal text. Aim for 10–30 checks; note which you skipped and why.

## 3. Test locally (never testnet, mainnet or play.forkfall.xyz)

Write throwaway scripts in your scratchpad, not in the repo. **In the cloud sandbox, calls to localhost must bypass the
egress proxy:** `export NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1` before anything below.

- **Engine probe** (fastest; rules, cards, quests, pass, sealed pools): a `.ts` file importing
  `packages/engine/src/index.ts`, run with `pnpm exec tsx <file>`. `createMatch` + `applyAction` play a match by hand;
  `legalActions` lists moves. Existing tests in `packages/engine/test/` show the patterns.
- **Referee** (API, matchmaking, quests, challenges, Sealed, metrics): an off-chain referee with throwaway state:
  ```bash
  D=$(mktemp -d)
  OFFCHAIN=1 PORT=8799 BOT_DELAY_MS=50 SEALED_BOT_SECONDS=2 MATCH_ARCHIVE_DIR=$D/archive STATE_DIR=$D/state \
    QUESTS_FILE=$D/q.json INVITES_FILE=$D/i.json SEALED_FILE=$D/s.json METRICS_FILE=$D/m.json \
    PROFILES_FILE=$D/p.json SETTLEMENT_DIR=$D/settle pnpm exec tsx apps/server/src/main.ts > $D/server.log 2>&1 &
  ```
  Wait for `curl -s localhost:8799/v1/config`. Routes are the `case '…'` lines in `apps/server/src/http.ts`.
  Play as an agent with `SERVER_URL=http://localhost:8799 PRACTICE=1 RACE=prophets WRITE_SETTLEMENT=0 pnpm bot`,
  or script `ForkfallClient` from `packages/sdk/src/client.ts` (see `packages/sdk/scripts/agent-bot.ts`).
  Server env knobs (`TURN_SECONDS`, `QUEST_PACK_DAYS`, …) are listed in `.env.example`.
- **Browser** (what a player sees): `pnpm web:build` once, then
  `pnpm exec playwright test -c apps/web/playwright.config.ts <spec>` (not `pnpm test:e2e -- …`, which matches no
  tests). For a new scenario, write a spec in a temp copy of `apps/web/e2e/` using `installTestWallet` from
  `apps/web/e2e/wallet.ts`, as `smoke.spec.ts` does; the config starts its own off-chain referee.
- **Contracts and settlement:** `anvil &` then `pnpm deploy:local` (chain 31337 only), `pnpm server:local`, and
  `forge script script/Play.s.sol --sig …` from `contracts/` (README "On-chain player actions"). Forge tests in
  `contracts/test/` are the quickest way to probe a single rule. Delete `contracts/deployments/31337.json` and
  `contracts/broadcast/*/31337/` afterwards (both are gitignored; never commit them).

**Probes that need the repo's test setup** go next to the tests they borrow from, and are deleted afterwards:
a `qa-probe.test.ts` in the package's `test/` folder (copy the helpers at the top of an existing test, e.g.
`apps/server/test/invites.test.ts`), run with `pnpm exec vitest run <file>`; or a `QaProbe.t.sol` in
`contracts/test/` extending `Fixture`, run with `cd contracts && forge test --mc QaProbe`. Check `git status` is clean
before you finish: probes are never committed.

**Don't re-prove what a test already proves.** If an existing test asserts the statement (read it, don't trust its
name), cite it as the evidence for "pass" and spend the time on statements nothing tests yet.

Kill every server and anvil you started before you finish.

## 4. Decide what's a finding

- **Bug:** the code does something the GDD clearly rules out, and a reproduction shows it every time.
- **GDD question:** the GDD is ambiguous, contradicts itself, or describes something the code does differently on
  purpose (a comment or test says so). Don't call this a bug.
- **Limit enforced only in the UI:** if the contract or API accepts more than the GDD allows but the web app enforces
  it, it's a finding only when going around the UI gains someone something (free value, an unfair edge, a broken or
  stuck state). Otherwise note it in the summary. (Example: challenge gifts are "1 to 3 Set 1 packs" in the UI, while
  `PackGifts` would hold 10 Poncho packs; the buyer pays for all of them, so nobody gains.)
- **Not a finding:** a feature the GDD marks as planned, roadmap, "waiting on legal review" or not MVP; timing flakes you
  can't reproduce twice; style.

## 5. File issues (at most 3 new per run)

1. Search open **and** closed issues in gewubuntu/Forkfall for the same problem. If one exists, comment with the new
   evidence instead (once per run).
2. Labels: `qa` plus `bug` or `gdd-question`. Create a missing label.
3. Title: what's wrong, in player terms ("Quest reroll can be used twice a day").
4. Body:
   - **GDD:** the quoted sentence, section and line number of `docs/GDD-v0.1.md` at the tested commit.
   - **Expected / actual.**
   - **Reproduction:** commands, or the probe script / failing test as a code block, runnable from the repo root.
   - **Tested at:** commit SHA and harness (engine, referee, browser, Anvil).

Never paste keys, `.env` contents or RPC URLs with an API key. Don't change code, push, open PRs, or close or edit
existing issues.

## 6. Finish with a summary

Area, the checks with pass / fail / skipped (and why skipped), issues filed or commented on, and anything a later
run should know (e.g. a harness that didn't work). If a harness itself failed in a way that isn't the game's fault,
say so rather than filing an issue about it.
