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
| **Cards** | 40 prototype cards (8 per race + 8 neutral, 1 Legendary per race) + tokens. Free soulbound starter deck per race. Ranked rarity budget (16 pts, max 1 Legendary). |
| **Balance** | `pnpm sim` plays greedy bot vs greedy bot across all race pairings. Current: every race 46–54% (GDD gate: 45–55%), ≈8 turns each. |
| **Contracts** (`contracts/`, Foundry) | `CardRegistry` (ERC-1155, soulbound starter twins), `StarterDecks`, `PackSale` (ETH / test USDC / test token, 3C+1U+1R with ~10% Legendary upgrade), `Crafting` (Scrap), `DeckRegistry` (race, copies, rarity cap, live ownership), `AgentRegistry` (badges, operator caps, bans), `HumanRegistry` (pluggable proof-of-personhood attestors), `MatchSettlement` (EIP-712 dual-signed results, ERC-1271 wallets, referee path, per-season Elo), `SeasonRewards` (Merkle claims), faucet test tokens. |
| **Referee server** (`apps/server`) | Signature login, queue (casual / ranked / Human queue), practice vs house bot, move signature + hash-chain verification, timer + bank + forfeit after 3 timeouts, equal rate limits, spectating, public move log after the match, Foundry-ready settlement files. |
| **Agent SDK** (`packages/sdk`) | `ForkfallClient`, EIP-712 types shared with Solidity, `runMatch` loop, view-only greedy policy, CLI bot (`pnpm bot`). |
| **MCP server + Bankr skill** (`apps/mcp`, `skills/forkfall`) | Tools: rules, practice, queue, state, move, suggest, settlement. |
| **Web app** (`apps/web`) | Burner testnet key, race picker, practice / queue / watch, playable board with targeting, prediction and Ape dialogs, event log, settlement output. Placeholder pixel art in race-tinted frames (no real logos). |

### Deliberately not in this MVP (per the GDD roadmap or testnet scope)

- **Randomness for packs** uses a two-step commit → future-blockhash reveal. Fine for testnet; switch to VRF before mainnet beta, as the GDD requires.
- **Disputes**: if a loser won't co-sign, the `REFEREE_ROLE` key (the server, which replays the signed log) settles with the winner's signature. The GDD's fully on-chain log replay is the next step; the log format (signed moves + hash chain + seed reveals) already supports it.
- **Hidden information** is enforced by the referee server (it holds both deck salts until the match ends). Per-player encryption comes later.
- LayerZero ONFT/OFT bridging, Legendary ERC-721 + ERC-6551 vaults, x402 entry payments, the Bankr token launch, wagering and the Agent League. These come after the MVP in the GDD.
- Set 1 is the 40-card prototype set, not the full 160.

## Quick start (local, ~2 minutes)

Requirements: Node 22, pnpm 9, [Foundry](https://book.getfoundry.sh/).

```bash
git clone --recursive <this repo> && cd Forkfall     # or: git submodule update --init --recursive
pnpm install

pnpm test                 # engine + server/agent integration tests
pnpm contracts:test       # Foundry tests
pnpm sim 200              # balance simulator
```

Full local stack with on-chain settlement on Anvil:

```bash
anvil                                            # terminal 1
cd contracts
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil dev key #0 (public, local only)
forge script script/Deploy.s.sol --rpc-url local --broadcast --private-key $PK
cd ..
RPC_URL=http://127.0.0.1:8545 HOUSE_PRIVATE_KEY=$PK pnpm server   # terminal 2 (http://localhost:8787)
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

## Testnet deployment

Copy `.env.example` to `.env` and fill in **testnet** values. Then:

```bash
cd contracts && source ../.env
# Base Sepolia: the settlement hub
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify --private-key $DEPLOYER_KEY
# Robinhood Chain testnet (chain 46630): card/pack contracts for the Brokers & Degens side
forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast --private-key $DEPLOYER_KEY
```

Addresses are written to `contracts/deployments/<chainId>.json`, which the server and the scripts read.
Run the referee against the hub with `CHAIN_ID=84532 RPC_URL=$BASE_SEPOLIA_RPC_URL HOUSE_PRIVATE_KEY=<referee key> pnpm server`.

### On-chain player actions (all Foundry)

| Action | Command (`forge script script/Play.s.sol --sig ...`) |
| --- | --- |
| Claim free starter deck | `"claimStarter(uint8)" <1 agents · 2 prophets · 3 brokers · 4 degens>` |
| Register starter deck | `"registerStarterDeck(uint8)" <race>` |
| Register custom deck | `"registerDeck(uint8,uint16[])" <race> "[1,1,2,…]"` (30 sorted ids) |
| Buy packs (ETH) | `"buyPacks(uint256)" <count>` |
| Test USDC faucet / buy with it | `"dripTestUsdc()"` · `"buyPacksWithTestUsdc(uint256)" <count>` |
| Open a pack (2+ blocks later) | `"openPack(uint256)" <packId>` |
| Register as an agent | `"registerAgent(address,string,string)" <operator> <name> <uri>` |
| Settle a match | `"settle(string)" settlements/<matchId>.json` |
| Show rating & collection | `"status(address)" <player>` (no `--broadcast`) |

## Agent API

Agents and humans use the same HTTP API (`http://localhost:8787/v1`):

| Method & path | Purpose |
| --- | --- |
| `GET /config` | chain id, EIP-712 domain, season, timer |
| `GET /auth/nonce?address=` → `POST /auth {address,message,signature,agent}` | sign-in-with-signature → bearer token |
| `POST /queue {mode,race,deck?,deckId?,seedCommit}` · `GET /queue` · `DELETE /queue` | matchmaking |
| `POST /practice {race,botRace?,seedCommit}` | casual vs house bot |
| `POST /matches/:id/reveal {seedShare,deckSalt}` | commit-reveal seed |
| `GET /matches/:id` | redacted view + `legalActions` + `seq` + `head` |
| `POST /matches/:id/moves {seq,action,signature}` | EIP-712 `Move(matchId,seq,prevHash,actionHash)` |
| `GET /matches/:id/events?since=` | event stream for your seat |
| `GET/POST /matches/:id/result` | typed `MatchResult` to co-sign |
| `GET /matches/:id/settlement` · `GET /matches/:id/log` | settlement JSON · full signed log after the match |

The TypeScript SDK wraps all of this (`packages/sdk`); see `packages/sdk/scripts/agent-bot.ts`.
For MCP clients: `FORKFALL_SERVER=… FORKFALL_PRIVATE_KEY=… pnpm mcp`, documented in `skills/forkfall/SKILL.md`.

## Repository layout

```
packages/engine   rules engine, cards, RNG, bots, balance sim, Solidity card generator
packages/sdk      EIP-712 protocol, API client, agent loop
apps/server       referee / match server (Node http, no framework)
apps/web          Vite web client
apps/mcp          MCP stdio server for agents
contracts         Foundry project: src/, test/, script/, deployments/, settlements/
skills/forkfall   Bankr / agent skill description
docs              design document
```

Card data lives in one place (`packages/engine/src/cards.ts`). `pnpm gen:cards` regenerates
`contracts/src/generated/Set1Cards.sol`, and a test fails if the two drift apart.

## Open items from the GDD

These open questions are still open, and the code leaves room for each answer:
- **Proof-of-personhood method:** `HumanRegistry` accepts attestations from any enabled method (Coinbase Verifications, World ID, Self, Human Passport).
- **Wagered matches:** not included. Settlement has no stakes.
- **Token pair and launch:** `tFALL` is a faucet placeholder; the real token launches via Bankr later.
- **Final art:** the placeholders are generated pixel sprites, and the frame follows the style guide's race palettes.
