---
name: qa-explorer
description: Test one area of the Forkfall GDD (docs/GDD-v0.1.md) against the running game and file GitHub issues, with reproductions, for what doesn't match. Use for scheduled QA runs ("run the qa-explorer skill for today's area") or when asked to check whether a GDD section is implemented as written.
---

# QA explorer: does the game do what the GDD says?

One run tests **one area** deeply. It never fixes anything: it finds mismatches, proves them, and files issues.
Follow `CLAUDE.md`, especially **Never**.

## 1. Pick the area

Unless the prompt names an area, take `areas[dayOfYear(UTC) % 15]` (day of year starting at 1). The GDD headings are
the source of truth; read the whole section, not only the bullets.

| # | Area | GDD heading | Code to read | Best harness |
| --- | --- | --- | --- | --- |
| 0 | Match rules | Core game loop & match rules | `packages/engine/src/engine.ts`, `apps/server/src/lobby/matchmaking.ts` | engine probe, referee |
| 1 | Races and balance | The four races | `packages/engine/src/cards.ts`, `engine.ts`, `bots.ts`, `packages/engine/scripts/simulate.ts` | engine probe, `pnpm sim` |
| 2 | Cards & deck rules | Cards & collection | `packages/engine/src/cards.ts`, `deckcode.ts`, `decks.ts` | engine probe, browser (`deckcodes.spec.ts`) |
| 3 | Packs and pity | Pack incentives without pay-to-win | `contracts/src/PackSale.sol`, `Crafting.sol` | forge probe, Anvil |
| 4 | Friend challenges | Friend challenges | `apps/server/src/lobby/challenges.ts` | referee, browser |
| 5 | Pack randomness | Pack randomness (Chainlink VRF) | `contracts/src/PackSale.sol`, `contracts/src/vrf/` | forge probe |
| 6 | Daily quests | Daily quests and free packs | `packages/engine/src/quests.ts`, `apps/server/src/quests.ts`, `contracts/src/QuestRewards.sol` | engine probe, referee |
| 7 | Season pass | Season pass | `packages/engine/src/pass.ts`, `contracts/src/SeasonPass.sol` | engine probe, referee |
| 8 | Sealed | Sealed events | `packages/engine/src/sealed.ts`, `apps/server/src/sealed.ts` | referee, browser (`sealed.spec.ts`) |
| 9 | Gifts & referrals | Gifts and referrals | `packages/engine/src/referrals.ts`, `apps/server/src/invites.ts`, `contracts/src/PackGifts.sol` | server test probe, forge probe |
| 10 | Alpha metrics | Alpha metrics | `apps/server/src/metrics.ts` | referee, browser (`metrics.spec.ts`) |
| 11 | Onboarding & cosmetics | Onboarding and cosmetics | `packages/engine/src/tutorial.ts`, `cosmetics.ts`, `apps/server/src/profiles.ts` | browser (`smoke.spec.ts`) |
| 12 | Poncho set | Poncho collab set (testnet prototype) | `packages/engine/src/cards.ts` (ids 41-48), `contracts/src/generated/Set1Cards.sol` | engine probe, `pnpm sim 500 poncho` |
| 13 | Humans, agents and season rewards | Humans & agents (+ Human queue) | `apps/server/src/humans.ts`, `auth.ts`, `rewards.ts`, `contracts/src/AgentRegistry.sol`, `HumanRegistry.sol`, `SeasonRewards.sol` | referee, forge probe |
| 14 | On-chain settlement & Agent League | On-chain architecture, Agent League economics | `contracts/src/MatchSettlement.sol`, `AgentLeague.sol`, `apps/server/src/league.ts`, `apps/server/src/lobby/league.ts`, `apps/server/scripts/publish-league.ts` | forge probe, Anvil |

## 2. Turn the section into checks

List every concrete, checkable statement: numbers, limits, timers, odds, caps, who may do what, what happens on
failure. Skip vision, pricing and legal text. Aim for 10–30 checks; note which you skipped and why.

## 3. Test locally (never testnet, mainnet or play.forkfall.xyz)

Write throwaway scripts in your scratchpad, not in the repo. **In the cloud sandbox, calls to localhost must bypass the
egress proxy:** `export NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1` before anything below.

Every server below gets its own temp dir for **all** state, so nothing lands in `apps/server/data/` or
`contracts/settlements/` (both gitignored, so `git status` wouldn't show the leak):

```bash
D=$(mktemp -d); PORT=$((20000 + RANDOM % 20000))
STATE="MATCH_ARCHIVE_DIR=$D/archive STATE_DIR=$D/state QUESTS_FILE=$D/q.json INVITES_FILE=$D/i.json \
  SEALED_FILE=$D/s.json METRICS_FILE=$D/m.json PROFILES_FILE=$D/p.json SETTLEMENT_DIR=$D/settle \
  REWARDS_DIR=$D/rewards LEAGUE_DIR=$D/league PORT=$PORT BOT_DELAY_MS=50 SEALED_BOT_SECONDS=2"
```

Start a server, then wait for **its own** log line, not just any answer on the port (another server may hold it):
`until grep -q 'listening on' $D/server.log; do sleep 1; done`, and check it didn't exit (`EADDRINUSE` in the log).

- **Engine probe** (fastest; rules, races, cards, quests, pass, sealed pools): a `.ts` file importing
  `packages/engine/src/index.ts`, run with `pnpm exec tsx <file>`. `createMatch` + `applyAction` play a match by hand;
  `legalActions` lists moves. Existing tests in `packages/engine/test/` show the patterns. Win rates and balance gates:
  `pnpm sim 500` / `pnpm sim 500 poncho`.
- **Referee** (API, matchmaking, quests, challenges, Sealed, metrics): an off-chain referee,
  `env OFFCHAIN=1 $STATE pnpm exec tsx apps/server/src/main.ts > $D/server.log 2>&1 &`.
  Routes are the `case '…'` lines in `apps/server/src/http.ts`. Play as an agent with
  `SERVER_URL=http://localhost:$PORT PRACTICE=1 RACE=prophets WRITE_SETTLEMENT=0 pnpm bot`, or script `ForkfallClient`
  from `packages/sdk/src/client.ts` (see `packages/sdk/scripts/agent-bot.ts`). The referee rate-limits each client to
  10 requests/s. A `429` from your own script means slow it down; a `429` that crashes the repo's own SDK or
`pnpm bot` is a finding (agents use them), but check open issues first. Other server knobs (`TURN_SECONDS`,
  `QUEST_PACK_DAYS`, …) are listed in `.env.example`.
- **Browser** (what a player sees): `pnpm web:build` once, then
  `pnpm exec playwright test -c apps/web/playwright.config.ts <spec>`; the config starts its own off-chain referee
  with temp state. A new scenario goes in `apps/web/e2e/qa-probe.spec.ts` (the config only runs specs in that
  folder), using `installTestWallet` from `apps/web/e2e/wallet.ts` as `smoke.spec.ts` does; delete it afterwards.
- **Contracts and settlement, local Anvil only (chain 31337):** `anvil > $D/anvil.log 2>&1 &`, then
  `pnpm deploy:local`, then `env $STATE pnpm server:local > $D/server.log 2>&1 &` (the same state overrides as above).
  Player actions from `contracts/`:
  `forge script script/Play.s.sol --sig "<signature>" <args> --rpc-url local --broadcast --private-key <the Anvil key in package.json's deploy:local>`.
  The README's "On-chain player actions" lists the signatures, but its `--rpc-url base_sepolia` and `--account`
  flags are for real players: **never use `base_sepolia` or any other network**. Afterwards delete
  `contracts/deployments/31337.json`, `contracts/broadcast/*/31337/` and `contracts/cache/*/31337/`.

**Probes that need the repo's test setup** go next to the tests they borrow from, and are deleted afterwards:
a `qa-probe.test.ts` in the package's `test/` folder (copy the helpers at the top of an existing test, e.g.
`apps/server/test/invites.test.ts`), run with `pnpm exec vitest run <file>`; or a `QaProbe.t.sol` in
`contracts/test/` extending `Fixture`, run with `cd contracts && forge test --mc QaProbe`. Before you finish, `git status --short --ignored apps/server/data contracts/settlements contracts/deployments apps/web/e2e`
must show nothing new: probes and run state are never committed or left behind.

**Don't re-prove what a test already proves.** If an existing test asserts the statement (read it, don't trust its
name), cite it as the evidence for "pass" and spend the time on statements nothing tests yet.

Kill every server and anvil you started (by the PIDs you started, not by pattern) before you finish.

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
2. Labels: `qa` plus `bug` or `gdd-question`. Create a missing label. Use the GitHub MCP tools
   (`search_issues`, `issue_write`, `add_issue_comment`), or REST through `gh api` (`POST /repos/{owner}/{repo}/labels`,
   `/issues`); the `gh issue` and `gh label` subcommands use GraphQL, which the sandbox refuses.
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
