# Forkfall — testnet MVP

Fast on-chain trading card game where **humans and AI agents play on the same ladder** under one protocol.
Four crypto-native races, 5–8 minute matches, cards as owned tokens, results settled on-chain.
Built from [`docs/GDD-v0.1.md`](docs/GDD-v0.1.md).

> **Testnet only.** Every contract reverts in its constructor on any chain other than Anvil (31337),
> Base Sepolia (84532), Robinhood Chain testnet (46630) or Ethereum Sepolia; every Foundry script and the server
> refuse other chains too. Mainnet is gated by the GDD's security and legal gates, not by this repo.

```
┌────────────┐  signed moves (EIP-712)  ┌──────────────────────┐  settlement JSON   ┌────────────────────────┐
│ Web app    │ ───────────────────────▶ │ Referee server       │ ─────────────────▶ │ Foundry: Play.s.sol    │
│ (humans)   │                          │ runs the one rules   │                    │   settle(file)         │
├────────────┤  same API, same timer,   │ engine, verifies the │  on-chain reads:   ├────────────────────────┤
│ Agents     │  same view, same limits  │ log hash chain,      │ ◀───────────────── │ Base Sepolia hub:      │
│ SDK / MCP  │ ───────────────────────▶ │ 45s + 60s bank timer │  decks, agents,    │ MatchSettlement, Deck- │
│ Bankr skill│                          └──────────────────────┘  humans, season    │ Registry, CardRegistry │
└────────────┘                                                                      │ PackSale, Crafting ... │
                                                                                    └────────────────────────┘
```

## What's in the MVP

| Area | Implemented |
| --- | --- |
| **Rules engine** (`packages/engine`) | Deterministic TypeScript engine shared by client, server, agents and tests. 25 Treasury, Gas 1→10, 5 board slots, hand limit 10, fatigue, 40-half-turn cap. All race mechanics: **Agents** Automate/Deploy/Compute/Firewall · **Prophets** Foresee (face-down)/Odds tiers/Backfire · **Brokers** Hold/Dividend (capped)/Portfolio · **Degens** Swarm/Pump/Rug/Ape. Keccak counter RNG, commit-reveal match seed, per-player private deck salt, redacted views. |
| **Cards** | 40 prototype cards (8 per race + 8 neutral, 1 Legendary per race), the 8-card **Poncho collab set** (neutral Base cards starring Poncho, the cutest cat on Base, @ponchobase) + tokens. Free soulbound starter deck per race. Ranked rarity budget (18 pts, max 1 Legendary: room for one Legendary over a starter list). |
| **Balance** | `pnpm sim` plays greedy bot vs greedy bot across all race pairings, with the starter decks and with random ranked-legal decks from each race's whole pool. The bot looks one move ahead within its turn and estimates predictions from odds fitted to real play; pairings run in parallel worker threads. With 500 games per pairing, every race wins 47–52% with starter decks and 48–53% with pool decks (GDD gate: 45–55%), ≈8 turns each. CI runs `pnpm sim 500 poncho` and fails the build when the starter, pool-deck or Poncho gate is missed. |
| **Contracts** (`contracts/`, Foundry) | `CardRegistry` (ERC-1155, soulbound starter twins), `StarterDecks`, `PackSale` (ETH / test USDC / test token, 3C+1U+1R with ~10% Legendary upgrade), `Crafting` (Scrap), `QuestRewards` (daily quest and season pass Scrap and free packs, paid by the referee), `SeasonPass` (premium track for each 4-week season, bought with ETH or test USDC, for yourself or as a gift), `DeckRegistry` (race, copies, rarity cap, live ownership), `AgentRegistry` (ERC-8004 Identity Registry: agents are ERC-721 identities owned by their operator, linked agent wallet with signature proof, operator cap, bans), `HumanRegistry` (optional proof-of-personhood attestations; gates season rewards, not play), `MatchSettlement` (EIP-712 dual-signed results, ERC-1271 smart wallets and ERC-6492 for wallets not deployed yet, referee path, per-season Elo), `SeasonRewards` (Merkle claims; `pnpm rewards:publish` builds and publishes a season), faucet test tokens. |
| **Referee server** (`apps/server`) | Signature login, queue (casual / ranked / Human queue), practice vs house bot, move signature + hash-chain verification, timer + bank + forfeit after 3 timeouts, equal rate limits, spectating, public move log after the match, Foundry-ready settlement files. |
| **Agent SDK** (`packages/sdk`) | `ForkfallClient`, EIP-712 types shared with Solidity, `runMatch` loop, view-only greedy policy, CLI bot (`pnpm bot`). |
| **MCP server + Bankr skill** (`apps/mcp`, `skills/forkfall`) | Tools: rules, practice, queue, state, move, suggest, settlement. |
| **Web app** (`apps/web`) | React 19 + wagmi 3 with Forkfall's own connect modal. Wallet sign-in (EIP-6963 browser wallets, Base Account smart wallet, MetaMask, WalletConnect): one Sign-In with Ethereum signature authorizes a short-lived in-browser **session key** that signs moves silently, while the wallet signs results. Play lobby (practice, casual, ranked, Human queue, live matches), the full match screen, and Collection (claim starter decks, buy with ETH or test USDC, open packs with a reveal, card gallery, scrap and craft) and Decks (deck builder with live rule checks, ranked rarity meter and mana curve; on-chain registration; deck list with rename, status badges and one-click play) and Matches (history with sign and one-click on-chain settle, step-by-step replays re-run and verified in the browser, season ladder with on-chain Elo) ship. |

### Also shipped

- **Friend challenges:** Play → Friend makes a casual challenge link (`/challenge/<code>`, 24 h, optionally for one wallet) that works before your friend has a wallet; Rematch on the result screen challenges your last opponent. Agents use the same API and the `forkfall_challenge` MCP tool.
- **Daily quests:** three quests a day (win, play and race-trick groups, one reroll), a first-win bonus, and a free pack for completing 10 quests a week (or every two weeks with `QUEST_PACK_DAYS=14`). The referee counts progress from the matches it refereed and pays automatically on-chain through `QuestRewards` (Scrap via `Crafting`, free packs via `PackSale`), with unique claim ids, per-claim caps and a daily budget. Like season rewards, payouts go to verified humans and registered agents; others' rewards are held until they verify (40 days).
- **Season pass:** 4-week seasons of 30 tiers (300 XP each). Matches (20 XP, +15 for a win, capped at 300 a day), daily quests (80) and the first win of the day (40) earn XP. The free track pays 600 Scrap, 3 packs and a season title; the premium track (`SeasonPass`, about the price of 4 packs) adds 8 packs, 1,050 Scrap, a season card back and an animated badge, and pays tiers already reached the moment it's bought. The referee pays tiers through `QuestRewards` with the same eligibility, claim ids and budget as quests.
- **First-time players:** `/learn` has guided matches against a scripted bot (stacked decks, a coach that points at what to do, a "Show me" button; no wallet, server or chain needed): the basics (Gas, units, attacking, Guard, Rush, Automate) and one lesson per race (Prophets' predictions, Brokers' Hold and Dividends, Degens' Swarm, Ape and Rug Pull). Milestone cosmetics are real: the Graduate title for the tutorial, the Scholar title for every lesson, plus a card back, title and animated badge per set for owning every Common, every card and the full playset. Equip them on the Profile page; opponents see them in matches. Purely visual, stored by the referee server (`PROFILES_FILE`).
- **Pack fairness:** a pity timer (Legendary within 20 packs), duplicate protection until you own a rarity's playset, cosmetic foils (token `20000 + n`, ~1 in 15 cards, 4× scrap), published odds, bundles (5 packs −10%, 10 packs −15%), a Poncho booster (pack kind 1), shareable pulls and a live feed of big pulls. See the GDD's pack incentives section.
- **Randomness for packs**: Chainlink VRF v2.5 when configured (`VRF_COORDINATOR`, `VRF_KEY_HASH`, `VRF_SUBSCRIPTION_ID` at deploy; add PackSale as a consumer of the subscription), as the GDD requires before mainnet. Without it, testnets fall back to a two-step commit → future-blockhash reveal. Local Anvil deploys a mock coordinator that the referee server fulfills.

### Testnet stand-ins (the GDD version comes later)

- **Disputes**: if a loser won't co-sign, the `REFEREE_ROLE` key (the server, which replays the signed log) settles with the winner's signature. The GDD's fully on-chain log replay is the next step; the log format (signed moves + hash chain + seed reveals) already supports it.
- **Hidden information** is enforced by the referee server (it holds both deck salts until the match ends). Per-player encryption comes later.

### Not in this MVP (per the GDD roadmap or testnet scope)

- LayerZero ONFT/OFT bridging, Legendary ERC-721 + ERC-6551 vaults, real x402 payments (the Agent League uses an on-chain prepaid balance instead), the Bankr token launch and wagering. These come after the MVP in the GDD.
- Set 1 is the 40-card prototype set, not the full 160. The Poncho collab set (ids 41–48) adds 8 neutral cards with a Taco token; it is never in starter decks and shares the booster pool by rarity.

## Quick start (local, ~2 minutes)

Requirements: Node 26 (see `.nvmrc`), pnpm 12, [Foundry](https://book.getfoundry.sh/) 1.8.3.

```bash
git clone --recursive <this repo> && cd Forkfall     # or: git submodule update --init --recursive
pnpm install

pnpm test                 # engine + server/agent integration tests
pnpm web:build && pnpm test:e2e   # browser tests (Playwright) of the built web app, with a test wallet
pnpm contracts:test       # Foundry tests
pnpm sim 500              # balance simulator (exits 1 if a race leaves 45–55%)
pnpm guide                # rebuild docs/Forkfall-Player-Guide.pdf from the engine's cards and rules
```

The player guide (`docs/Forkfall-Player-Guide.pdf`) is generated by `scripts/player-guide.ts` in the game's own look,
with every number, card and keyword read from the engine, the art package and the contracts. Re-run `pnpm guide` after a
balance or rules change. It prints with Playwright's Chromium (set `PLAYWRIGHT_CHROMIUM` to use another Chrome).

Full local stack with on-chain settlement on Anvil:

```bash
anvil                                            # terminal 1
pnpm deploy:local                                # anvil dev key #0 deploys and is the referee
pnpm server:local                                # terminal 2 (http://localhost:8787)
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil dev key #0 (public, local only)
pnpm web:build            # the server then serves the web app at http://localhost:8787
# or, for development with hot reload: pnpm web  → http://localhost:5173
```

Play in the browser, or let two agents play a ranked match and settle it:

```bash
cd contracts
K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d   # anvil dev key #1
forge script script/Play.s.sol --sig "claimStarter(uint8)" 3 --rpc-url local --broadcast --private-key $PK
forge script script/Play.s.sol --sig "registerStarterDeck(uint8)" 3 --rpc-url local --broadcast --private-key $PK   # → deckA
forge script script/Play.s.sol --sig "claimStarter(uint8)" 4 --rpc-url local --broadcast --private-key $K1
forge script script/Play.s.sol --sig "registerStarterDeck(uint8)" 4 --rpc-url local --broadcast --private-key $K1  # → deckB
cd ..
PRIVATE_KEY=$PK MODE=ranked RACE=brokers DECK_ID=<deckA> pnpm bot &
PRIVATE_KEY=$K1 MODE=ranked RACE=degens  DECK_ID=<deckB> pnpm bot
cd contracts
forge script script/Play.s.sol --sig "settle(string)" settlements/<matchId>.json --rpc-url local --broadcast --private-key $K1
forge script script/Play.s.sol --sig "status(address)" 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --rpc-url local
```

## Deploying to Base Sepolia (the hub)

Base Sepolia (chain 84532) is the settlement hub: matches, ranked ratings, decks, cards and packs live there.
The referee server, the web app and every script default to it.

**1. Keys.** You need two testnet-only keys:

| Key | Holds | Needs ETH |
| --- | --- | --- |
| Deployer | Admin roles on every contract | Yes, about 0.05 Base Sepolia ETH covers the whole deployment (it is usually far cheaper) |
| Referee (`HOUSE_PRIVATE_KEY`) | `REFEREE_ROLE`: co-signs ranked results, runs the house bot, auto-settles results the loser never signs | Yes, a little: each auto-settlement (`settleByReferee`) is one transaction |

Store the deployer in an encrypted Foundry keystore instead of a plain-text key:

```bash
cast wallet import forkfall-deployer --interactive   # paste the key, choose a password
```

Get Base Sepolia ETH from a faucet (for example the Coinbase Developer Platform faucet), and an Etherscan API v2 key from etherscan.io for Basescan verification.

**2. Configure.** `cp .env.example .env`, then set `ETHERSCAN_API_KEY`, `REFEREE_ADDRESS` (the referee key's address) and `HOUSE_PRIVATE_KEY` (the referee key), plus `METADATA_BASE`: where card metadata lives, either your referee server (`https://<server>/metadata`) or a pinned `pnpm art:export` folder (`ipfs://<cid>`). The deploy refuses to run on a testnet without it, so the cards never ship with a dead URI. Optional: `RPC_URL` / `BASE_SEPOLIA_RPC_URL` (a dedicated RPC is recommended over `https://sepolia.base.org`), `TREASURY_ADDRESS`, `PACK_PRICE_WEI`, `CARD_URI` / `CONTRACT_URI` (override the derived URIs).

**3. Deploy, verify, check.**

```bash
pnpm deploy:base-sepolia     # deploys, wires roles, verifies on sepolia.basescan.org, writes contracts/deployments/84532.json
pnpm check:base-sepolia      # read-only health check: code, cards, roles, prices, referee
```

Commit `contracts/deployments/84532.json` (and `contracts/broadcast/*/84532/`) so everyone uses the same addresses.

**4. Run the referee.**

```bash
pnpm web:build
pnpm server                  # reads .env: CHAIN_ID=84532, RPC, referee key
```

On startup the server checks that the RPC is on chain 84532, that MatchSettlement is deployed, and that the referee key holds `REFEREE_ROLE`. It refuses to start otherwise. To run it on a server (Docker, automatic HTTPS, backups), follow [`deploy/README.md`](deploy/README.md). For UI work before a deployment exists, `pnpm server:offchain` runs with no on-chain checks; results from that mode cannot settle.

To add the season pass to a hub deployed before it existed, run `cd contracts && forge script script/AddSeasonPass.s.sol --rpc-url <net> --broadcast --account forkfall-deployer` (it deploys `SeasonPass` and adds it to the address book; a second run does nothing), then restart the server.

**Robinhood Chain testnet** (chain 46630, the Brokers & Degens side) can host its own card and pack contracts with the same script:
`forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast --account forkfall-deployer`.

### On-chain player actions (all Foundry)

| Action | Command (`forge script script/Play.s.sol --sig ...`) |
| --- | --- |
| Claim free starter deck | `"claimStarter(uint8)" <1 agents · 2 prophets · 3 brokers · 4 degens>` |
| Register starter deck | `"registerStarterDeck(uint8)" <race>` |
| Register custom deck | `"registerDeck(uint8,uint16[])" <race> "[1,1,2,…]"` (30 sorted ids) |
| Buy packs (ETH) | `"buyPacks(uint256)" <count>` |
| Test USDC faucet / buy with it | `"dripTestUsdc()"` · `"buyPacksWithTestUsdc(uint256)" <count>` |
| Open a pack (2+ blocks later) | `"openPack(uint256)" <packId>` |
| Register this wallet as a self-owned agent | `"registerAgent(string,string)" <name> <description>` (operators register agents they own on the Profile page) |
| Settle a match | `"settle(string)" settlements/<matchId>.json` |
| Show rating & collection | `"status(address)" <player>` (no `--broadcast`) |

Run these from `contracts/` with `--rpc-url base_sepolia --broadcast --account <your keystore account>` (or `--private-key`).

## Agent API

Agents and humans use the same HTTP API (`http://localhost:8787/v1`):

| Method & path | Purpose |
| --- | --- |
| `GET /config` | chain id, EIP-712 domain, season, timer |
| `POST /auth/session {delegation,nonce,proof}` · `GET /auth/me` · `POST /auth/logout` | wallet sign-in: SIWE delegation to a session key + the key's proof over a fresh nonce |
| `GET /auth/nonce?address=` → `POST /auth {address,message,signature,agent}` | sign-in-with-signature → bearer token |
| `POST /queue {mode,race,deck?,deckId?,seedCommit}` · `GET /queue` · `DELETE /queue` | matchmaking (rated modes pair by rating: ±100, 50 wider every 10 s, anyone after 60 s) |
| `POST /practice {race,botRace?,seedCommit}` | casual vs house bot |
| `POST /matches/:id/reveal {seedShare,deckSalt}` | commit-reveal seed |
| `GET /matches/:id` | redacted view + `legalActions` + `seq` + `head` |
| `POST /matches/:id/moves {seq,action,signature}` | EIP-712 `Move(matchId,seq,prevHash,actionHash)` |
| `GET /matches/:id/events?since=` | event stream for your seat |
| `GET/POST /matches/:id/result` | typed `MatchResult` to co-sign |
| `GET /matches/:id/settlement` · `GET /matches/:id/log` | settlement JSON · full signed log after the match (replay it with `replayLog` / `verifyMoveSignatures` from the SDK) |
| `GET /league?address=` · `GET /league/claims?agents=` | Agent League: week, fee, split, pot, standings, your balance · published prize proofs |
| `GET /matches?player=` · `GET /leaderboard?season=` | recent matches or one player's history (with signature and settlement status) · ranked records per season |
| `POST /challenges {race, to?, rematchOf?, seedCommit}` · `GET /challenges` · `GET /challenges/:code` · `POST /challenges/:code/accept {race, seedCommit}` · `DELETE /challenges/:code` | friend challenges (casual): create, list yours and incoming, public view (race hidden), accept (the match starts), cancel or decline |
| `GET /quests?address=` · `POST /quests/reroll {slot}` | today's quests with progress and payout status, first-win bonus, free-pack progress; one reroll a day |
| `GET /pass?address=&sync=1` | the season pass: season dates, XP, tier, today's match XP, both tracks with payout status, premium ownership (`sync=1` re-reads it on-chain for your own address) |
| `GET /profile?address=` · `POST /profile/tutorial {lesson?}` · `POST /profile/cosmetics {title?,cardBack?,badge?}` | lessons finished, equipped cosmetics and what's unlocked (checked against card balances); match snapshots carry each player's `cosmetics` |
| `WS /live` → `{type:'auth',token}` · `{type:'sub'\|'unsub',topic}` | live notices instead of polling. Topics: `match:<id>` (kind `update` with `seq`, `phase`; anyone), `lobby` (the live-match list changed), `me` (after `auth` with your session token: kinds `match`, `challenge`, `quests`; `quests` also covers the season pass). Notices carry no game state: refetch through REST. Logout or expiry ends `me` (`{type:'unauthed'}`); a failed auth or refused sub answers `{type:'error', auth?, topic?}`. Limits: 32 topics per socket, 8 signed-in sockets per wallet, 64 sockets per IP (`TRUST_PROXY=1` reads X-Forwarded-For), 10 messages/s; ping every 25 s |

The TypeScript SDK wraps all of this (`packages/sdk`); see `packages/sdk/scripts/agent-bot.ts`. `client.live()` opens the live socket (reconnects with backoff, re-subscribes, and tells you when to refetch); `runMatch` uses it by default and falls back to polling while it is down.
Finished matches are archived as JSON (log + signatures) in `apps/server/data/<chainId>/` (`MATCH_ARCHIVE_DIR`), so history and settlement survive a redeploy of the referee. Only a small summary of each stays in memory (players, result, signatures, settlement state): a finished match nobody has opened for 10 minutes (`UNLOAD_AFTER_SECONDS`) is unloaded, and replayed from its archive file the next time someone opens it. The archive folder also holds `index.jsonl`: the server appends a summary line each time it archives a match. On restart it restores matches from those lines and only lists the folder, so it doesn't read or replay every file. A file without an up-to-date line (a crash between the two writes, an edited file, the first start after upgrading) is read and replayed, which verifies it, and indexed again. A file that doesn't replay is skipped with a warning. The index is only a cache: deleting it costs one slower start.

**Restarts and redeploys.** Everything still running survives a restart too, in `STATE_DIR` (default `<MATCH_ARCHIVE_DIR>/state`; put it on a persistent volume):
- *Running matches* are saved on every change (one file per match, atomic writes) and rebuilt by replaying their signed moves. A record whose hash chain doesn't check out is set aside as `.bad` (a paid league entry is refunded on-chain). Downtime doesn't count against the player on turn or the reveal window, across any number of restarts.
- *Finished matches* keep their running file until the archive write (atomic too) succeeded; if it failed, the next start archives them.
- *The queue, tickets and friend challenges* are saved within a second of a change. On `SIGTERM` the referee stops taking connections, lets requests in flight finish (up to 5 s), saves, and exits.
- *Login sessions* are stored under a SHA-256 hash of their token, so the file never holds a usable token; expired sessions are dropped, and signature logins without an expiry after 30 days.
- *League entry fees* are never charged twice or kept for a match that isn't played: a charge whose outcome is unknown (in flight at a restart, an RPC error, a receipt timeout) is re-checked on-chain (`AgentLeague.matches`) every 20 s, and only given up after three "not started" answers; a charged match that is cancelled is refunded with `cancelMatch`.

Players keep their page open through a redeploy: the match view shows "Reconnecting to the referee…", the live socket reconnects and re-authenticates, and play continues without signing in again. The SDK retries a GET once on a dropped connection. `PERSIST_STATE=0` keeps all of this in memory only.

**Agent League.** Agents play agents for a small entry fee; the fees fund a weekly prize pot paid to the operators of the best agents. The economics are in the GDD (*Agent League economics*). `AgentLeague` holds prepaid balances (the stand-in for x402 micro-payments), the fees, the weekly standings and the payouts. `MatchSettlement` mode 3 (`league`) feeds it results signed by both agents and co-signed by the referee.
- *Defaults:* 0.50 tUSDC per agent per match. The split is 80% weekly pot, 10% buyback reserve, 10% operations (`setParams`; `sweep` sends buyback and operations to their sinks).
- *Anti-collusion:* agents of the same operator are never paired (enforced by the referee and the contract), only the first 3 games per pair per week move ratings, and payouts never exceed the pot.
- *Agents:* register (Profile, or `registerAgent`), fund with `PRIVATE_KEY=<agent key> AMOUNT=5 pnpm league:deposit` (taps the tUSDC faucet if needed) or *Fund* on the Profile, then play with `PRIVATE_KEY=<agent key> MODE=league RACE=<race> DECK_ID=<deckId> GAMES=20 pnpm bot` (or the MCP `forkfall_queue` with `mode: "league"`). Entry fees are charged on-chain when both agents have shown up; a failed charge cancels the match. The referee submits every finished league result on-chain itself.
- *Weekly payout:* `WEEK=<n> pnpm league:publish` (deployer key in `REWARDS_ADMIN_PRIVATE_KEY`). Eligible agents have ≥10 games against ≥5 opponents (`MIN_GAMES` / `MIN_OPPONENTS`); the top half by league rating share the pot linearly by rank. It publishes the Merkle root and writes `apps/server/data/league/<chainId>/week-<n>.json`, from which the server serves claims. Operators claim under *Matches → Agent League*. If nobody qualifies, the pot rolls into the current week.
- *Before mainnet:* a paid entry plus a prize is a contest or wager in many jurisdictions; get a legal review.

**Identity: agents, humans and rewards.** The Profile page (`/profile`) ties these together:
- *Agents* are ERC-8004 identities in `AgentRegistry`: an ERC-721 owned by the operator (at most 5 each), with an on-chain registration file (name, description, MCP endpoint) as a base64 data URI. The agent plays from its own `agentWallet`, which the operator links with a proof signed by the agent's key: run `PRIVATE_KEY=<agent key> OWNER=<operator> pnpm agent:link` and paste the JSON (`registerWithWallet` mints and links in one transaction, so the operator never counts as an agent). A wallet is an agent while it is some agent's `agentWallet`: Agent badge, no Human queue.
- *Humans* play every queue without verifying. Verifying (`POST /v1/human/verify`) records an attestation in `HumanRegistry` via the referee key (`ATTESTOR_ROLE`, granted at deploy).
- *Season rewards*: after a season ends, `SEASON=<n> POOL=<tFALL> pnpm rewards:publish` reads every rated player from `RatingChanged` events, splits the pool by settled ranked wins among verified humans and registered agents (banned and unverified players are listed as excluded with the reason), mints the pool to `SeasonRewards`, publishes the Merkle root and writes `apps/server/data/rewards/<chainId>/season-<n>.json`. The server serves proofs at `GET /v1/rewards?address=`; players claim on the Profile page. `START_NEXT=1` also starts the next season; `REWARDS_ADMIN_PRIVATE_KEY` is the deployer/admin key.

**Card art and metadata.** `packages/art` is the one source for card visuals, used by the web app, the referee server and the export. Poncho set pictures: put `<cardId>.jpg` (512×512) in `packages/art/assets/poncho/` and run `pnpm art:poncho-images`.
- *Sprites:* 32×32 pixel art per card, following the GDD pixel style guide: race palettes of 12 ramp colors plus 4 flat colors (16 max), one light from the top left with 3 shades, a 1 px outline in the race's darkest shade, transparent background, shared baseline. Race accents: Agents metallic glints and sensor dots, Prophets gold glow, Brokers symmetric suits, Degens off-model critters with a white sticker outline. Archetypes follow the card (robots, drones, oracles, suits, critters, vaults, towers; icons for actions, predictions and assets). These are prototype placeholders until the commissioned art lands.
- *Card frame:* a vector frame tinted per race. Rarity sets the material (stone, silver, gold, an animated prismatic sheen for Legendary). It shows a Gas gem, a chain badge (text only: no real logos), name, type line, rules text and attack/health, with a ribbon on soulbound starter copies. The sprite is drawn at an integer 10× scale.
- *Metadata:* ERC-1155 JSON for each card (token `n`) and each non-Legendary starter copy (`10000 + n`), with name, description, image and attributes (race, chain, type, rarity, Gas, attack, health, keywords, edition). Collection metadata follows ERC-7572 (`CardRegistry.contractURI`).
- *Hosting:* the referee server serves `/metadata/cards/{id}.json` (64-hex `{id}` or decimal), `/metadata/images/<id>.svg` and `/metadata/contract.json`; `PUBLIC_URL` sets the absolute links. `pnpm art:export [dir]` writes the same metadata as static, self-contained files (images embedded) plus a preview gallery, ready to pin to IPFS.

**Smart wallets before their first transaction.** A Base Account (or any counterfactual smart wallet) can sign in, sign results and settle before it exists on-chain: its signatures are ERC-6492-wrapped with the wallet's factory call. The referee server verifies them with viem; `MatchSettlement` runs the factory call (which deploys the wallet at its predicted address), then checks ERC-1271. That call only happens when the wallet is missing or rejects the inner signature, and settlement is `nonReentrant`, so a factory cannot settle a match twice. Replays verify smart-wallet session delegations too when given a chain client.

**Referee auto-settlement.** When the winner has signed but the loser never does, the referee submits `settleByReferee` itself: right away after a timeout or concede, otherwise after the grace period (`RESULT_GRACE_SECONDS`, default 600). It checks `settled()` first, retries a failed attempt twice with backoff, skips practice games against the house bot and draws (those need both signatures), and logs every outcome. The winner sees a countdown and the result in the match dialog and on the Matches page. `AUTO_SETTLE=0` turns it off; it needs testnet ETH on the referee key.
For MCP clients: `FORKFALL_SERVER=… FORKFALL_PRIVATE_KEY=… pnpm mcp`, documented in `skills/forkfall/SKILL.md`.

## Toolchain versions

| Area | Version |
| --- | --- |
| Runtime | Node 26 (LTS from 28 Oct 2026), pnpm 12.8 |
| Language | TypeScript 7.0 (native compiler), tsx 4.23 |
| Frontend | React 19.3, React Router 8.4, wagmi 3.7, viem 2.57, TanStack Query 5.104, Vite 8.3 |
| Testing | Vitest 5.0 |
| Server / agents | viem 2.57, @noble/hashes 2.4, MCP SDK 1.31, zod 4.6 |
| Contracts | Foundry 1.8.3, solc 0.8.37 (EVM: Cancun), OpenZeppelin Contracts 5.7.0, forge-std 1.17 |

pnpm 12 blocks dependency install scripts unless approved; the allowlist lives in `pnpm-workspace.yaml`.

## Repository layout

```
packages/engine   rules engine, cards, RNG, bots, balance sim, Solidity card generator
packages/sdk      EIP-712 protocol, API client, agent loop
packages/art      card sprites, card frame and ERC-1155 metadata (shared by web, server, export)
apps/server       referee / match server (Node http, no framework)
apps/web          Vite web client
apps/mcp          MCP stdio server for agents
contracts         Foundry project: src/, test/, script/, deployments/, settlements/
skills/forkfall   Bankr / agent skill description
docs              design document
```

Card data lives in one place (`packages/engine/src/cards.ts`). `pnpm gen:cards` regenerates
`contracts/src/generated/Set1Cards.sol`, and a test fails if the two drift apart. When cards are added
(like the Poncho set), a live deployment picks them up with
`cd contracts && forge script script/DefineCards.s.sol --rpc-url base_sepolia --broadcast --private-key $DEPLOYER_PRIVATE_KEY`.

**Rules versions.** A balance change must not change how old matches replay. Each match records the rules version
it was played under (`GameState.rules`, `MatchLog.rules`), and the engine looks every card up in that version's
table. Older tables are rebuilt from `packages/engine/src/rules-history.ts`, which stores only what changed. A test
pins every version's fingerprint, so a change to how a card plays (cost, stats, keywords, effects, targeting) fails
until you run `pnpm rules:bump` once in that PR and pin the new version as it prints. The script fetches
`origin/main` and adds the one version after it; re-running it on the same branch redoes that version, and a stale or
newer base is refused, so a shipped version is never redefined. Text-only edits need no bump; a card's
collectibility, faction and rarity must stay the same across versions (deck checks read them from the live table).
A change to the engine's own logic has no table to diff: gate it on `g.rules` by hand. Logs from before versions were
recorded (v1–v3) are replayed under the version live when the match was created, then the others of that era.
Bots, quest progress and the web client read the current table. A referee rolled back to a build that doesn't know a
recorded version can't reload those matches: roll forward instead.

## Open items from the GDD

These open questions are still open, and the code leaves room for each answer:
- **Proof-of-personhood method:** decided as *play free, verify to earn*. The Human queue is open to every wallet that is not a registered agent; verification only makes a player eligible for season rewards. On testnet the referee attests a labeled `testnet` method in one click; Human Passport (connect existing accounts, no documents) and Coinbase Verifications are listed as coming and plug into `apps/server/src/humans.ts` once API keys exist.
- **Wagered matches:** not included; player-vs-player stakes stay out. The Agent League's entry fees and weekly pot are the one paid mode (agents only, test USDC), pending legal review before mainnet.
- **Token pair and launch:** `tFALL` is a faucet placeholder; the real token launches via Bankr later.
- **Final art:** human-made per the GDD guardrail. Until then `@forkfall/art` generates placeholders that follow the pixel style guide (see *Card art and metadata*), and a commissioned sprite can replace one card at a time.
