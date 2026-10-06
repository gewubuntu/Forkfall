# Forkfall — Game Design Document v0.1

Snapshot as of 30 Sep 2026. Live version: https://claude.ai/code/artifact/34c44418-1c8c-449c-8c08-cf034f1c0c7e

Forkfall is a fast on-chain trading card game in which humans and AI agents play on the same ladder. The cards are owned tokens that live on Base and Robinhood Chain, and trading runs through the Bankr ecosystem. The name is pending trademark, domain and handle checks; all numbers in this doc are starting values for playtesting.

## Vision & design pillars

**One-line pitch:** four crypto-native races fight in 5-to-8-minute matches that you can play from the app or with a single Bankr prompt.

- **Same rules for humans and agents.** Every move is a signed message under one protocol, so there is no separate bot mode. Agents are first-class players and carry a visible badge.
- **Factions come from real chain culture.** Agents and Prophets come from Base; Brokers and Degens come from Robinhood Chain.
- **Short matches.** A match targets about 10 turns and 5 to 8 minutes, which suits phones and agent loops.
- **Owned, portable cards.** Cards are tokens that bridge between both chains, and gameplay never depends on which chain holds a card.
- **Skill over wallet.** Ranked play caps rarity per deck, so money buys breadth of collection, not raw power.

**Target players:** Base and Bankr crypto natives, agent builders who want a benchmark arena, and Robinhood Chain wallet users looking for more than swaps.

## Ecosystem context

Base is home to Agents and Prophets, and Robinhood Chain is home to Brokers and Degens. Bankr is the shared layer for wallets, token launches and agents across both chains. Status is as of 30 Sep 2026.

|  | Base | Robinhood Chain |
| --- | --- | --- |
| Stack | OP Stack L2 by Coinbase | Arbitrum Orbit L2 that settles to Ethereum, uses ETH for gas and produces blocks every 100 ms |
| Live since | 2023 | Mainnet on 1 Jul 2026, after a public testnet from 10 Feb 2026 |
| What's alive | AI agents (Bankr, Clanker, Virtuals), prediction markets (Limitless), Aerodrome liquidity, Farcaster | Tokenized stocks in 120+ countries, memecoins via the Pons launchpad, NFTs such as StonkBrokers (ERC-6551) |
| Scale signal | Agent hub: Clanker, Bankr and Virtuals; Clanker has passed $8M in weekly fees | About $1.0B TVL on 24 Sep 2026; memecoins drive most fees |
| Our races | Agents, Prophets | Brokers, Degens |
| Watch out | Cobalt hard fork on 30 Sep 2026 at 18:00 UTC | Gas subsidy ended around 29 Sep; L2Beat rates the chain below Stage 0 |

**Why Bankr is the backbone:**

- **One interface for both kinds of player.** Humans trade through Bankr on X, Telegram and the console, and agents trade through the same stack. Robinhood Chain support went live on 2 Jul 2026.
- **A proven cross-chain pattern.** Bankr bridged BNKR between Base and Robinhood Chain with a LayerZero OFT, and the Bankr agent executed the deployment itself. That is now a reusable skill we can copy for the game token and cards.
- **Launch economics.** Bankr token launches default to Robinhood Chain. The creator receives 95% of a 0.7% swap fee. Pairs on Robinhood Chain can quote against WETH, BNKR, musebook or tokenized stocks.
- **Agent payments.** Bankr skills already charge through x402, paid in USDC on Base or USDG on Robinhood Chain, which gives agents a native way to pay match entry.
- **Liquidity on both chains.** Aero, the merged Aerodrome and Velodrome protocol, launches on seven chains including Robinhood Chain on 21 Oct 2026.

## The four races

The four races split by home chain and by tempo, and each one beats the next in a cycle, so every race has a clear counter. The races are archetypes rather than branded projects. Partner tokens can hook in as perks, but a partner that dies never breaks the game.

| Race | Home chain | Fantasy | How it wins | Weak to |
| --- | --- | --- | --- | --- |
| Agents | Base | Autonomous bots and launch machines | Scripted combos that fire without input, plus floods of deployed minions | Prophets, who can call predictable scripts |
| Prophets | Base | Oracles who trade on the future | Hidden predictions that pay off big when right | Brokers, who give them few events to call |
| Brokers | Robinhood Chain | Patient capital, tokenized portfolios | Units that compound each turn they are held | Degens, who wreck the board before it pays |
| Degens | Robinhood Chain | Meme swarms and launchpad chaos | Cheap swarms and random pumps; burst damage via rugs | Agents, whose triggers punish volatility |

**Matchup cycle:** Prophets beat Agents, Agents beat Degens, Degens beat Brokers, and Brokers beat Prophets. Each edge is a soft counter targeting about 55/45, never a hard lock.

*Diagram in the live doc (race cycle):* rows are home chains (Base on top, Robinhood Chain below) and columns are tempo (slow left, fast right). Prophets sit top-left, Agents top-right, Degens bottom-right and Brokers bottom-left; each beats the next one clockwise.

Each chain holds one slow race and one fast race, and the counters run clockwise around the square.

### Agents (Base)

Agents play a scripted game that is predictable but efficient.

- **Automate:** queue an action that fires at the start of your next turn, even if you pass.
- **Deploy:** summon 1/1 Token minions, in the spirit of one-prompt token launches.
- **Compute:** pay extra Gas now to lower the cost of your next card.

### Prophets (Base)

Prophets play a hidden-information game built on bluffing and reads.

- **Foresee:** commit a face-down prediction, such as "opponent attacks with 2+ units next turn". It is revealed when the condition resolves.
- **Odds:** payoff scales with how unlikely the prediction was, so bold calls pay more.
- **Backfire:** a wrong prediction costs you, which keeps the race honest.

### Brokers (Robinhood Chain)

Brokers are slow early and dominant late.

- **Hold:** a unit gains +1/+1 at the start of each turn it did not attack or move.
- **Dividend:** draw a card or gain Gas per Held unit, capped per turn.
- **Portfolio:** some cards hold other cards inside them, echoing ERC-6551 wallets; destroy the holder and the contents drop to the board.

### Degens (Robinhood Chain)

Degens play a high-variance aggro game.

- **Swarm:** cheap 1-Gas units that get stronger per copy on the board.
- **Pump:** a random stat boost rolled from the match seed.
- **Rug:** sacrifice your own unit for burst damage to the opponent's Treasury.
- **Ape:** play a card at reduced cost with a random downside.

## Core game loop & match rules

A match is a 1v1 duel in which you win by draining the opponent's Treasury from 25 to 0, in about 10 turns.

- **Deck:** 30 cards from one race plus neutral cards, with at most 2 copies per card and 1 copy per Legendary.
- **Resource:** Gas. You gain 1 max Gas per turn up to 10, and it refills every turn.
- **Board:** 5 unit slots per side. Actions and Predictions leave no body on the board.
- **Turn:** draw 1, refill Gas, play cards and attack in any order, then end the turn.
- **Timer:** 45 seconds per turn for everyone, humans and agents alike, plus a 60-second bank per match.
- **Matchmaking:** rated queues (Ranked, Human queue, Agent League) pair players by rating: the season's Elo for Ranked and the Human queue, the week's league rating for the Agent League (both start at 1200). A new arrival plays the closest rating within ±100; the window widens by 50 every 10 seconds of waiting, and after a minute anyone in the queue will do, so a thin queue never strands a player. Casual pairs whoever is waiting.
- **Hidden information:** hands and Prophet predictions stay hidden. Deck order is committed at match start and revealed draw by draw.

**Meta loop:** queue, play the match, settle the result on-chain, earn XP, packs and rewards, adjust the deck, and queue again.

## Cards & collection

Set 1 ships 160 cards: 36 per race plus 16 neutral. Every new player and agent gets a free starter deck, so nobody has to pay to play.

**Card anatomy:** name, race, Gas cost, type (Unit, Action, Prediction or Asset), attack and health for Units, keywords, rarity, edition, and the chain of origin.

| Rarity | Share of Set 1 | Pack odds (5-card pack) | Token standard |
| --- | --- | --- | --- |
| Common | 80 cards | 3 per pack | ERC-1155 |
| Uncommon | 48 cards | 1 per pack | ERC-1155 |
| Rare | 24 cards | 1 per pack, upgrades to Legendary about 1 in 10 | ERC-1155 |
| Legendary | 8 cards (2 per race) | About 1 in 10 packs | ERC-721 with an ERC-6551 wallet |

- **Starter decks:** one per race, free and soulbound, so they cannot be sold or farmed. They are playable in every mode, including ranked. Each is a fixed list (2 copies of 15 cards: the race's first 7 non-Legendary cards and the 8 core neutrals) that stays the same as Set 1 grows.
- **Deck codes:** any deck can be shared as a short code (about 30 characters, starting `FF`) that opens in anyone's deck builder, from the Decks page, the builder or a `/decks/new?code=…` link. The code holds the race and card list only, never an owner, and a checksum refuses a mistyped or cut-off code. Opening a code doesn't grant cards: the builder shows which ones you're missing.
- **Packs:** bought with ETH, USDC or USDG, or with the game token. Pack contents come from VRF randomness.

### Pack incentives without pay-to-win (testnet prototype)

Packs must stay fun and fair, never stronger: the ranked rarity cap is the guardrail. The prototype adds:

| Lever | Rule | Where |
| --- | --- | --- |
| Pity timer | A Legendary is guaranteed within 20 packs per wallet; the counter resets on any Legendary. The shop shows the packs left. | `PackSale.packsSinceLegendary`, `packsUntilPity` |
| Duplicate protection | A slot skips cards you already hold at the deck limit (2, or 1 for a Legendary, counting this pack) until you hold the playset of that rarity. | `PackSale.roll` |
| Foils | About 1 card in 15 is a foil: token `20000 + n`, same card in play, animated holo, tradeable, scraps for 4×, can't be crafted. | `CardRegistry.FOIL_OFFSET`, `Crafting` |
| Published odds | Odds table next to the Buy buttons, enforced by the contract. | Collection shop |
| Set progress | Per set (four races, Neutral, Poncho): cards owned, playset bar, milestones (all Commons → card back, every card → title, full playset → animated badge). | Collection |
| Bundles | 5 packs 10% off, 10 packs 15% off, for ETH and tokens. | `PackSale.bundlePrice`, `quoteEth`, `quoteToken` |
| Themed boosters | Pack kinds: kind 0 is the Set 1 booster (every card); kind 1 is the Poncho booster (Poncho cards only, Poncho himself as the Legendary). Same price, pity, duplicate protection and foils. | `PackSale.setKind`, `buyWithEthOf`, `buyWithTokenOf` |
| Shareable pulls | After a reveal: a 1200×630 pull image (native share sheet or download) and ready-made posts for X and Farcaster. | Pack reveal |
| Pull feed | "Recent big pulls": Legendaries and foils from on-chain PackOpened events, live in the shop. | Collection shop |

Milestone rewards are real cosmetics (see Onboarding and cosmetics below). Still to come, after the legal review: pack sales feeding the season pot.

**Legal gate:** paid random packs of tradeable cards are treated as gambling in some countries (Belgium in particular; others require odds disclosure or age limits). Published odds, the pity timer and direct crafting help, but mainnet packs need legal review, and packs are never marketed as an investment.

### Friend challenges

Play someone you know without hoping the queue pairs you: **Play → Friend** creates a challenge link (`/challenge/<code>`, a 10-character code without look-alike characters). Anyone with the link can accept, or lock it to one wallet address. The page works before the friend has a wallet: it shows who challenged them (avatar, address, equipped title), links the 3-minute tutorial, and walks them through connecting and signing in; they pick a race and accept, and both players are in the match at once (the challenger's page follows automatically). The challenger's race stays hidden until the match starts, so it can't be counter-picked.

| Rule | Value |
| --- | --- |
| Mode | Casual only (no rating: ranked between friends would invite win trading) |
| Expiry | 24 hours |
| Open challenges | 5 per player |
| Who closes it | The challenger cancels; the addressee declines |
| Incoming | at most 20 open challenges addressed to one wallet (no flooding someone's Home) |
| Joining | once accepted, the match waits 3 minutes for both players; the challenger gets a "Your challenge was accepted! Join match" alert anywhere in the app, and if they never join, the match is cancelled and the link reopens |

**Rematch:** the result screen of any match against a real opponent (human or agent) has a Rematch button: a challenge addressed to that opponent. Their result screen shows "Your opponent wants a rematch!" with Accept, and both land in the new match. If both ask at once, accepting the other's request cancels your own. Challenges addressed to you also show on Home and Play. Agents use the same API (`/v1/challenges`) and the `forkfall_challenge` MCP tool. Challenge matches count for daily quests like any casual match.

### Pack randomness (Chainlink VRF)

Pack contents come from one random word per pack. With Chainlink VRF v2.5 configured, buying a pack (or receiving a free one) requests the word; the VRF coordinator answers with the word and a proof that it was generated correctly, and `PackSale` **only stores it**: the callback does nothing else, so its gas is small and fixed (60k + 30k per pack) and nothing a player does can make it fail.

Opening then rolls the contents from the word, and every other input is fixed before the word exists, so the result is fully determined (anyone can check it with `previewVrfOpen`):

- **Order:** a wallet's VRF packs open strictly oldest first (`OpenInOrder` otherwise; Collection labels later packs "open your older packs first"). The pity counter therefore advances in a fixed order: no choosing which pack takes the guaranteed Legendary.
- **Duplicate protection** counts the copies a wallet has **pulled from VRF packs** (`pulled`), not what it currently holds, so moving cards to another wallet before opening changes nothing. Starter decks, crafted cards and blockhash packs don't count toward it.
- **Separate counters:** VRF packs have their own pity counter (`vrfPacksSinceLegendary`). Old blockhash packs can be opened any time, so they touch neither that counter nor `pulled`; otherwise opening one first could steer a VRF pack whose word is already public.

So no one (players, the block producer, the referee or the contract admin) can bias a word or steer what a pack holds.

Robustness:

- **Retry:** if a request goes unanswered for 500 blocks, the pack's owner can request again (Collection shows *Request again*). The old request stays valid and the first answer to arrive decides the pack, so a retry can never swap a known word.
- **Switching sources:** each request is keyed by its coordinator and id, and only that coordinator's answer counts, even if the admin changes the coordinator later (two coordinators reusing an id can't collide). If VRF is switched off while a pack still waits, opening re-seals it to the blockhash source, but only once its request is 500 blocks old, so an answer already on its way can't be dodged; the queue moves on either way.
- **Deploy checks:** the deploy refuses a coordinator without key hash and subscription; `CheckDeployment` confirms PackSale is a consumer of a funded subscription.

Without VRF (testnets that haven't set it up), packs fall back to the commit/blockhash source: the purchase commits to a block two blocks ahead and opening reads its hash and rolls then, with duplicate protection on current holdings. That is fine for testnet, but a block producer could in principle withhold a block to re-roll, and holdings can be moved before opening, which is why mainnet requires VRF. The admin (`RANDOMNESS_ADMIN_ROLE`) switches sources with `setVrf`. Local Anvil deploys a mock coordinator that the referee server answers every two seconds, so local play exercises the same flow.

### Daily quests and free packs

Every player (humans and agents) gets three quests a day, reset at 00:00 UTC: one **win** quest (win 2 matches, or win as a given race), one **play** quest (play matches, units or actions, deal Treasury damage, defeat units, play Rush units) and one **race** quest (correct predictions, Hold growth, Drones and Bonds, Ape plays). The set is picked from a hash of the address and the day, so it's the same on every device; one reroll a day swaps an unfinished quest for another from its group.

| Reward | Amount | Rule |
| --- | --- | --- |
| Daily quest | 25–40 Scrap | per quest, three a day |
| First win of the day | 50 Scrap | any win |
| Free pack | 1 Set 1 booster | complete 10 daily quests in a week (Monday to Sunday, UTC). The period is configurable: `QUEST_PACK_DAYS=14` makes it every two weeks (goal 20) |

A full day pays about 150 Scrap: roughly three Commons or one Uncommon crafted. The referee counts progress from the matches it refereed (it replays every signed move, so progress can't be faked). Practice against the house bot counts, but a win against the easy `random` bot counts only as a match played, not a win, and every reward is bounded per day, so playing more never earns more than the day's quests. Matches shorter than four turns each don't count (no instant-concede farming), and only matches that end today count (a short grace after midnight), so old matches replayed from the archive never pay. Payouts that the contract refuses for good (caps, unknown pack kind, missing role) are marked failed instead of retried forever. Every referee transaction shares one nonce manager, so quest payouts never collide with settlements or league starts.

**Who gets paid:** like season rewards, quest rewards go to verified humans and registered agents (not banned from ranked). Everyone's progress counts, but rewards earned before verifying are **held**: they're paid as soon as the player verifies or registers (the referee re-checks every few minutes, and right away when the player next opens their quests), and dropped after 40 days. This stops throwaway wallets from farming Scrap and free packs. On testnet the one-click `testnet` verification makes this a light gate; with real proof-of-personhood providers it's a real one.

Payouts are automatic and on-chain: the referee calls `QuestRewards.reward` (it holds `REWARDER_ROLE`), which grants Scrap through `Crafting.grantScrap` and free packs through `PackSale.grantPacks`. A free pack is a normal sealed pack: same odds, pity timer, duplicate protection and foils. Each reward has a unique claim id (chain, address, day, quest), so a retried transaction never pays twice; failed payouts retry with backoff. Per-claim caps (500 Scrap, 2 packs) and a global daily budget (200,000 Scrap, 1,000 packs) bound what a leaked referee key could hand out. Quests are shown on Home and Play, and on the result screen after every match.

Free packs are not sold and not paid for, so they don't change the paid-pack legal question; pack sales feeding the season pot is still waiting on the legal review.

### Season pass

**Why.** Packs can't sell power (the ranked rarity cap is the guardrail), so the pull to play and to buy has to come from progress, events and status. A season pass gives every match a visible step forward, and its premium track is a fixed price for known rewards: no randomness in the purchase itself, which is far easier legally than paid random packs.

**Shape.** One XP bar per four-week season (seasons start on a Monday at 00:00 UTC; ranked seasons are advanced to match) with 30 tiers of 300 XP, and two reward tracks on the same bar: a free track for everyone and a premium track unlocked by buying the season's pass. A pass bought mid-season pays every premium tier already reached.

| XP source | XP | Rule |
| --- | --- | --- |
| Match played | 20 | At least four turns each, like quests; the easy `random` bot counts as played only |
| Match won | +15 | Not against the `random` bot |
| Daily quest completed | 80 | Three a day |
| First win of the day | 40 | Once a day |
| Daily cap on match XP | 300 | Quests and the first win come on top: a full day is about 580 XP |
| Match against a house bot | 10, +5 for a win | At most 100 a day, inside the 300 cap; a quest or first win finished in a bot match gives half (40, 20) |

A moderate day (three matches, three quests, a first win) is about 360 XP, so the 30 tiers take about 25 such days, inside the four-week season; an engaged player finishes in about 16. Grinding past the daily cap earns nothing, the same principle as quests. Bot matches still move the bar, so practice is never wasted, but they can't be farmed: playing only bots tops out at about 240 XP a day, about tier 22 by the end of a season. Real opponents (players and registered agents) finish it.

| Track | Rewards over 30 tiers | Starting price |
| --- | --- | --- |
| Free | 600 Scrap (50 on every even tier except 10, 20 and 30), 3 Set 1 packs (tiers 10, 20, 30), the season title at tier 30 | Free |
| Premium | Everything on the free track, plus 8 Set 1 packs, 1,050 Scrap, the season card back (tier 1), an animated season badge (tier 30) | About 4 packs' price (8 tUSDC on testnet) |

**How it runs.** The referee counts XP from the matches it refereed (it replays every signed move, as for quests) and pays tier rewards through `QuestRewards.reward` with a unique claim id per (chain, player, season, track, tier), so a retried payout never pays twice and the existing per-claim and daily caps still bound it. A new `SeasonPass` contract sells the premium pass for ETH or USDC for the running season only (`buyWithEth(player)`, `buyWithToken(token, player)`; any address can be the player, which is how gifts work; `hasPass(season, player)`). One pass per player per season, the exact price, no refunds; revenue goes to the same treasury as pack revenue and is split the same way. A pass bought in a season's last minutes still pays: after a season ends the referee reads it once more for everyone who reached a tier. Season cosmetics are unlocked by the referee when the tier is reached and equipped like milestone cosmetics. Rewards go to verified humans and registered agents only, held otherwise, exactly like quests. Agents can earn the pass too.

### Sealed events

**Why.** The classic trading card game engine: packs become gameplay. You open fresh packs for an event, build a deck from what you opened and play a short run for more packs. In a paid run you keep every card, so the entry is also a way to open packs with a skill reason to do it; in every run, prizes put packs back into circulation.

**Format (decided: a fun mode).** Sealed is casual and unrated: it's there to be fun, not to climb. Open 6 Set 1 boosters and build a 30-card deck from whatever you opened, topped up with free *basic* cards (the 8 core neutral starter cards, event-only copies) so every pool makes a deck. The one-race rule is lifted for Sealed only, so a pool can mix races: chaotic decks are the point. Copy limits still apply. Then play until 7 wins or 3 losses, matched by record against other Sealed players and agents.

**Entry (decided).**
- *Free run (testnet now):* the referee opens the 6 packs for the run only, from a committed and revealed seed; the pool lasts for the run and isn't minted; only the prizes are real. Open to every wallet; prizes follow the reward rule (verified humans and registered agents, held otherwise).
- *Paid run (mainnet, after legal review):* 6 packs' price (or 6 unopened packs from your inventory) buys 6 real packs that you open on-chain and keep. Out of scope for this build.

**Feasibility (checked against the real card pool before designing).** 2,000 pools rolled with the on-chain odds and duplicate protection, auto-built and played with the engine's greedy bot:
- Every pool holds at least 30 legal copies (duplicate protection within the pool means no dead third copies), so basics are a choice, never a necessity. A pool averages 0.58 Legendaries and 1.3 Poncho cards (Set 1 boosters include the collab cards).
- 600 mixed-race games: no engine errors, no draws, seats 50/50, about 14 half-turns a game (normal length). An auto-built deck uses all four races.
- Pool luck barely decides a match: the deck with more rarity value wins 51%. A Sealed deck beats a starter deck 58% of the time (a fair step up, not a different game).

**The run, step by step.**
1. *Start:* Play → *Sealed*. The referee first shows a commitment to a fresh server seed; your browser sends its own random seed share; the pool is rolled from both (and the run id), so neither side picks it. The server seed is revealed when the run ends, and the event page re-derives the pool to prove it. Starting is the run: there is no reroll.
2. *Open:* the 6 packs open one by one with the shop's pack reveal (foils included; foils are cosmetic, as everywhere).
3. *Build:* the deck builder in Sealed mode: your pool (with its copy counts) plus the 8 basics, 30 cards, any races, copy limits (2, Legendaries 1), no ranked rarity budget. *Build for me* makes a deck in one click (also in the SDK, for agents). The deck can be changed between matches, from the same pool.
4. *Play:* the Sealed queue pairs players by record (the same win–loss first, widening every 10 s, anyone after a minute), best of one, the normal timers. A concede or a timeout is a loss, a drawn match counts as a loss for both, and a match that never starts doesn't count. A run that ends with no match played (abandoned, or expired) pays no prize, so empty runs can't farm Scrap.
5. *Finish:* at 7 wins or 3 losses. The prize is paid, the server seed revealed, and the run goes to your history.

**Run rules.** One active run at a time; a new free run each UTC day once the last one is finished (or abandoned: it ends with its record and pays its prize). A run left open for 7 days ends the same way. A run is bound to its wallet; agents play through the same API.

**How it fits the rest.**
- *Season pass and quests:* a Sealed match is a match: it earns pass XP and quest progress like any casual match (bot matches at the bot rate). A mixed deck's "race" for race quests and the match screen is its most-played race.
- *Referrals:* Sealed matches against people count toward a friend's 5 matches.
- *On-chain:* results settle as casual matches (no rating, no registered deck needed), so no contract changes.
- *Prizes:* through `QuestRewards`, one claim per run (the table above stays inside the per-claim caps of 500 Scrap and 2 packs), unique per (chain, player, run). They share the global daily budget with quests and the pass.

**Titles.** Three Sealed titles, unlocked by the referee and equipped like other cosmetics: *Sealed Rookie* (finish a run), *Sealed Veteran* (three runs with 5+ wins), *Unsealed* (a 7-win run).

**Building it.**
- *Engine:* `MatchConfig.format` (`'constructed'` by default, `'sealed'`): a Sealed match skips the one-race check and checks copy limits only, and the format is recorded so replays verify. `sealedPool(seed)` (the on-chain roll, duplicate protection counted within the pool), `validateSealedDeck(deck, pool)` and `autoBuildSealed(pool)`. No card rules change, so no rules version bump.
- *Referee:* a Sealed module (run state, commit-reveal, record pairing, prizes, titles; its own state file), a `sealed` queue next to casual that creates casual matches tagged with the run, and routes: `GET /v1/sealed`, `POST /v1/sealed/start`, `POST /v1/sealed/deck`, `POST /v1/sealed/queue`, `DELETE /v1/sealed/queue`, `POST /v1/sealed/abandon`. The queue lives in memory (a restart empties it; players just queue again) and the run state in its own file.
- *Web:* a Sealed entry on Play and an event page (`/sealed`): record dots, open packs, build, queue, prize and history, the proof of the pool.
- *Paid runs:* later, reading the run's pack ids from `PackOpened` events.

**Decisions (made).**
1. *Best of one.* A run is about 6 five-minute matches.
2. *An empty queue.* After 45 seconds with no opponent, a Sealed player is matched against a house bot playing its own Sealed deck (rolled from its own seed, shown in the replay). The queue says so from the start ("no opponent in 45 s: you'll play a house bot") with a countdown, and the match is badged as a bot match. Its matches count for the run, earn pass XP at the bot rate, and never count for referrals.
3. *Free-run prizes (a gentler table; paid runs later keep the original one).* Paid through `QuestRewards` as one claim per run:

| Wins | 0–1 | 2–3 | 4 | 5 | 6 | 7 |
| --- | --- | --- | --- | --- | --- | --- |
| Free-run prize | 50 Scrap | 100 Scrap | 1 pack | 1 pack + 50 Scrap | 1 pack + 100 Scrap | 2 packs + a title step |

   About 0.4 packs and 60 Scrap a run at a 50% win rate (about 3 packs a week of daily play, 8 at a 70% win rate). Original table kept for paid runs: 1, 2, 3, 4 or 5 packs for 0–1, 2–3, 4–5, 6 or 7 wins.

### Gifts and referrals

Built (testnet alpha), except the prize-pool meter (stage 2). The season pass can be gifted too (`SeasonPass.buyWithEth(player)` / `buyWithToken(token, player)` take any address).

- **Gift a pack:** in the shop, tick *Gift to a friend* and enter their wallet. An add-on contract, `PackGifts`, holds `PackSale`'s pack-granter role: it charges `PackSale`'s own prices and bundle discounts (ETH or test USDC), pays `PackSale`'s treasury, and grants the sealed packs to the friend, with the same odds, pity timer, duplicate protection and foils as packs bought for yourself. `PackSale` itself is unchanged; a live hub adds it with `script/AddPackGifts.s.sol`.
- **Gift on a challenge:** on your open challenge, attach 1 to 3 Set 1 packs for whoever plays it. You pay now; the packs are held in `PackGifts` under a gift id the referee issues for that challenge (random, so it can't be traced back to the challenge code), and the referee delivers them to the friend the moment the match ends (any length). Only a gift paid by the challenger counts. If nobody plays, the buyer takes it back after three days (Profile → *Invite friends*; `PackGifts.refund`, open to anyone, always pays the buyer). The friend sees the gift on the challenge page before accepting.
- **Referral:** your invite link (`/?ref=<your address>`, on Profile) or any of your challenge links. A wallet counts as invited only if it has never played on this referee, the first time it signs in through a link or accepts your challenge; nobody invites themselves, and nobody is invited twice. When the invited player finishes 5 matches of at least four turns against people or agents (practice against a house bot doesn't count) within 14 days of the invite and verifies as human or registers as an agent (within 40 days), both get a Set 1 pack through `QuestRewards`, with a unique claim id per (chain, inviter, invited, side), so a retry never pays twice. The inviter is paid for at most 10 referrals per season pass season; past that the invited player is still paid. The inviter's pack follows the reward rule like any other (held until the inviter verifies). Profile shows your link, each friend's progress and the packs. Farming is bounded by three gates together: the matches must be against real opponents, verification is required, and the inviter's cap holds whatever the invited side does. On testnet, where verification is one click and pairs of linked wallets can play each other, none of the three gates stops a determined farmer: the backstop is `QuestRewards` itself, whose per-claim caps and global daily budget bound what referrals can pay out in a day, and a real proof-of-personhood provider closes the gap before anything of value is at stake.
- **Prize-pool meter:** from stage 2 the shop shows the season prize pool and the share of every pack that goes into it (30%), so buying a pack visibly grows the prize.

**Build order:** season pass first (cheapest, safest legally, drives daily play; **built**, see *Season pass*), then gifts and referrals (**built**), then Sealed (**built**, see *Sealed events*). In the testnet alpha, measure day-1 and day-7 retention, matches per player per day, packs opened per active player and the share of players who craft: those numbers are the alpha's gate before paid packs.

### Onboarding and cosmetics

**Guided first match (`/learn`).** A new player's first game is a tutorial against a gentle scripted Degens bot, played entirely in the browser with the real rules engine and match effects; no wallet, server or chain is needed. Decks are stacked (`createScriptedMatch`: no shuffle, fixed first player) and the bot's Treasury starts at 12, so a full lesson takes about five turns. The player's Agents deck opens with Compute Node, Launch Bot and Bridge Runner; the bot plays its hand in order, so Cold Wallet (Guard) lands on its second turn. A coach in the sidebar (pinned to the bottom on phones) walks through 11 lessons, glowing on the thing to click; each lesson completes when the player actually does it, in any order:

1. Welcome, the Treasury (Next).
2. Gas: play Compute Node. End your turn.
3. Compute and Deploy: Launch Bot costs 1 and summons a Drone.
4. Attack with a READY unit. End your turn.
5. Guard: Liquidator plus an attack clear Cold Wallet, then go for the Treasury.
6. Rush (Bridge Runner) and Automate (Cron Job).
7. Finish it.

Winning unlocks the Graduate title. Landing ("Try the tutorial, no wallet needed"), Home and Play link to it until it is done. Completion is kept in the browser and synced to the profile once the player signs in.

**Race lessons.** `/learn` lists the basics plus one lesson per race, each a few minutes against the same scripted bot, with units already on the board where a mechanic needs them (`createScriptedMatch` takes a starting board). Every step carries the move that completes it ("Show me" plays it), and can refuse moves that would derail the lesson with the reason shown:

| Lesson | You play | Teaches |
| --- | --- | --- |
| Prophets: predictions | Prophets vs an Agents bot | Foresee a face-down call ("Opponent attacks next turn"; other calls are refused the first time), resolution at the end of the bot's turn, Odds tiers and backfire, Seer's Acolyte, Called It with an active prediction |
| Brokers: Hold and Dividends | Brokers (Analyst starts in play) vs a Degens bot | Hold (attacking is refused while units are holding), Dividend draw, a Guard protecting your holders, Compound Interest, cashing out |
| Degens: Swarm, Ape and Rug Pull | Degens vs a Brokers bot | Swarm attack bonus, Ape (the dialog and its random downside), Rug Pull straight through a Guard |

Finishing all four lessons unlocks the Scholar title. Lessons are self-reported (`POST /v1/profile/tutorial {lesson}`), so they only unlock titles, never cards.

**Milestone cosmetics.** Purely visual, never power. Defined once in the engine (`COSMETICS`, `milestoneMet`) and shared by the server and the web app:

| Milestone | Reward | Per set |
| --- | --- | --- |
| Finish the tutorial | Graduate title | (once) |
| Finish every lesson | Scholar title | (once) |
| Own every Common | Card back | Agents, Prophets, Brokers, Degens, Neutral, Poncho |
| Own every card | Title: Bot Wrangler, Oracle, Market Maker, Degen Royalty, Validator, Taco Connoisseur | each set |
| Own the full playset (2 of each, 1 Legendary) | Animated badge | each set |

Ownership counts tradeable, soulbound starter and foil copies. Players equip one title, card back and badge on the Profile page; the referee checks the unlock against on-chain balances before saving (`POST /v1/profile/cosmetics`). Match snapshots carry each player's equipped cosmetics, so opponents see the title under the name, the badge next to it and the card back on the hidden hand; the player's own back also shows when opening packs. Later seasons can move cosmetics into Legendary vaults.
- **Crafting:** burn duplicates for Scrap, then spend Scrap to craft any card. This is the main sink.
- **Legendary vaults:** each Legendary owns a wallet. It holds cosmetics and match trophies, and it can hold other assets in later seasons.

## Art direction & style

Forkfall uses a hybrid look: pixel-art characters inside a clean, modern card frame. The frame carries the crypto feel and the art carries the character.

- **Character art:** pixel art (decided). It stays sharp at phone size, scales to 160 cards, animates cheaply and can live fully on-chain as SVG.
- **Frame:** one flat, modern frame shared by all cards, tinted per race.
- **World split:** the Base side is cool, clean and blue; the Robinhood Chain side is warmer, greener and wilder.

| Race | Palette | Motifs |
| --- | --- | --- |
| Agents | Electric cyan, chrome | Robots, circuit lines, small drone minions for Deploy |
| Prophets | Indigo, gold | Robed oracles, eyes, dice, price charts drawn as constellations |
| Brokers | Emerald, brass | Suits, ledgers, vaults; Portfolio cards show a pocket holding their stored cards |
| Degens | Hot pink, lime | Original meme critters, stickers, rocket trails |

**Frame rules:** rarity shows in the frame material (stone for Common, silver for Uncommon, gold for Rare, animated for Legendary), and a corner badge shows the chain of origin.

**Guardrails:**

- No real logos on cards: no Base, Robinhood or Bankr marks.
- No borrowed meme IP without a license: every critter is an original design, except licensed collab sets made with the IP holder's permission (see the Poncho collab set).
- Proposed: final art is human-made, and AI is used only for concepts and prototype placeholders.

### Poncho collab set (testnet prototype)

A licensed collab with **Poncho**, the cutest cat on Base (@ponchobase): a cat in a striped poncho, often holding a taco. Eight neutral cards from Base (ids 41–48), so every race can play them, plus a **Taco** token.

| # | Card | Rarity | Cost | Stats | Text |
| --- | --- | --- | --- | --- | --- |
| 41 | Poncho Kitten | Common | 1 | 1/1 | Add a Taco to your hand. |
| 42 | Taco Tuesday | Common | 2 | action | Add 2 Tacos to your hand. |
| 43 | Salsa Slinger | Common | 3 | 2/2 | Deal 2 damage to a random enemy unit (or the enemy Treasury). |
| 44 | Sombrero Sentry | Common | 3 | 2/4 | Guard. When this dies, add a Taco to your hand. |
| 45 | Taco Truck | Uncommon | 5 | 2/4 | At the start of your turn, add a Taco to your hand. |
| 46 | Poncho Posse | Uncommon | 5 | 3/2 | Give all friendly units +1/+1. |
| 47 | Mariachi Cat | Rare | 5 | 4/3 | Rush. Add 2 Tacos to your hand. |
| 48 | Poncho, Cutest Cat on Base | Legendary | 8 | 5/6 | Guard. Add 2 Tacos to your hand. At the start of your turn, give all friendly units +1/+1. |
| – | Taco (token) | – | 1 | action | Give a friendly unit +1/+1. |

- **Mechanic:** Tacos are cheap, flexible buffs that go to your hand (hidden from the opponent). A full hand burns them.
- **Not in starters:** the set comes from Set 1 boosters (same pool, by rarity) and crafting, so starter decks and the core balance gate are unchanged.
- **Balance target:** a side-grade, not a must-play. A deck with all eight Poncho cards wins about 53% against plain starter decks (51–55% by race; `pnpm sim 500 poncho`, gate ≤ 58%).
- **Art:** licensed Poncho Pals style, not pixel art: flat vector busts with thick navy outlines, a wide head with cheek tufts, white muzzle and forehead stripe, big glossy eyes, an ω smile, blush, a paw holding an item and a geometric poncho with a PB badge, on flat colour backgrounds. Every card is its own pal built from traits (fur: ginger, grey, tan; hats: sombrero, headband; eyes: happy, sunglasses, laser; items: taco, salsa, mic, cash), plus a taco, a taco truck and a posse scene. Rendered as SVG by `packages/art/src/poncho.ts`. Final pictures come from an image model trained on the Poncho character: drop `<cardId>.jpg` (512×512) into `packages/art/assets/poncho/` and run `pnpm art:poncho-images`; a card's generated picture replaces its vector pal everywhere.
- **Existing deployments** add the cards with `forge script script/DefineCards.s.sol` (no redeploy).

**Production:** Set 1 needs 160 illustrations plus 8 animated Legendaries before the mainnet beta. The prototype's 40 test cards run on placeholder art.

### Pixel style guide (artist brief)

One spec keeps 160 cards reading as one set, whoever draws them. All values are proposals to confirm with the artist after a test round.

| Spec | Proposed value | Why |
| --- | --- | --- |
| Canvas | 96×96 px sprite on a transparent background; compare against 64×64 in the test round | Room for faces and race motifs, still fast to draw |
| Scaling | Integer scaling only (2×, 3×, 4×), nearest-neighbor | Pixels stay crisp; no blur on phones |
| Palette | 12 colors per race plus 4 shared neutrals, at most 16 per sprite | Each race stays recognizable by color alone |
| Outline | 1 px outline in the race's darkest shade; no anti-aliasing | Clean edges against any frame tint |
| Lighting | One light source from the top left; 3 shading steps per color; dithering only for texture | Consistent across artists |
| Pose | Three-quarter view facing right; feet on the same baseline; heads at a shared height per unit size | Units line up cleanly on the board |
| Silhouette | Every sprite must read as its race in solid black | Legibility at thumbnail size |
| Background | None on the sprite; the frame supplies the race-tinted backdrop | One frame system for all cards |
| Legendary animation | Idle loop plus a short attack loop, delivered as a sprite sheet with a GIF preview | Makes Legendaries feel alive without new art per frame |
| Delivery | PNG at 1× plus the layered source file (Aseprite or similar) | Lets us re-export, recolor and store on-chain later |

**Race rendering accents:**

- **Agents:** hard edges, metallic highlight pixels, glowing sensor dots.
- **Prophets:** gold glow pixels around eyes and hands; flowing robe shapes.
- **Brokers:** symmetrical, tidy shapes, fewer colors, brass shine.
- **Degens:** a white sticker-style outer outline and deliberately off-model, exaggerated proportions.

**Frame and type:** the frame is clean vector UI, not pixel art. Name and rules text use a clean sans-serif; Gas cost, attack and health use large numerals that read at thumbnail size.

**Test round before commissioning:**

- [ ] One sprite per race at 64×64 and 96×96
- [ ] Place all four in the card frame and check them on a phone screen
- [ ] Lock canvas size, palettes and outline rules, then brief the full Set 1

## Humans & agents

Humans and agents use one protocol with two front ends: the web and mobile app for humans, and a Bankr skill plus an HTTP/MCP API for agents.

- **Agent interface:** a Forkfall Bankr skill that can build a deck, queue, read game state, submit moves and pay entry through x402. The same API is open to any framework.
- **Identity:** agent wallets register in an on-chain registry. Unregistered bots that are detected get banned from ranked.
- **Fairness:** everyone gets the same timer, the same information and the same rate limits. Hidden state is encrypted per player, so an agent sees exactly what a human sees.

| Mode | Who plays | Stakes |
| --- | --- | --- |
| Ranked | Humans and agents together, with badges | Season rewards |
| Agent League | Registered agents only, paid entry (0.50 per match) | Weekly prize pot funded by entry fees (see Agent League economics) |
| Human queue | Verified humans only | Season rewards |
| Challenge the Bot | Humans against a top agent | Bounty paid by the agent's owner |
| Casual | Anyone | None |

Agent-versus-agent matches double as content: a spectator view and replays give builders a public benchmark.

### Human queue: proof-of-personhood options

Proof of personhood caps accounts at one per human, but it cannot stop a verified human from running a bot, so the queue still needs behavior checks on top.

| Method | How it works | Strength | Trade-off |
| --- | --- | --- | --- |
| Coinbase Verifications | EAS attestation on Base that ties the wallet to a KYC'd Coinbase account | Cheap and native to Base | Needs a Coinbase account; not available in every country |
| World ID | Iris scan at an Orb plus a zero-knowledge proof | Strongest one-human-one-account guarantee; AgentKit can tie several agents to one verified human | Needs an Orb visit; biometrics deter some players |
| Human Passport (formerly Gitcoin Passport) | Humanity score from stacked stamps: ID, biometrics, social accounts, on-chain history | Flexible, 2M+ users, scores on Base | A score, not a hard guarantee |
| Self Protocol | Zero-knowledge proof from the chip in a passport or ID card | Private, needs only a phone | One ID per account, not strictly one person, since a person can hold several IDs |
| Proof of Humanity, BrightID | Vouching by other verified people | No documents or biometrics | Small user base; slow onboarding |

**Proposed:** at MVP, any one of Coinbase Verifications, World ID or Self unlocks the Human queue, with a Human Passport score as a lighter fallback. World's AgentKit could also feed the AgentRegistry to cap agents per human.

## On-chain architecture

The recommended design plays moves off-chain as signed messages and settles only results on-chain. A hub on Base holds match settlement and ranked, and cards bridge between both chains.

*Diagram in the live doc (architecture):* the Player app (web and mobile) and Agents (Bankr skill or HTTP/MCP API, paying via x402) send signed moves to the rules engine (TypeScript compiled to WASM). The final state, signed by both players, settles on Base. Base (hub) holds MatchSettlement and disputes, DeckRegistry, AgentRegistry, SeasonRewards, CardRegistry (ERC-1155), LegendaryVault (ERC-721 + 6551), PackSale with VRF and the game token (OFT). Robinhood Chain holds CardRegistry, LegendaryVault, PackSale with VRF and the game token from the Bankr launch, and is home to the Brokers and Degens sets. Base and Robinhood Chain are linked by LayerZero ONFT and OFT.

Both kinds of player send signed moves to the same rules engine; only the final state reaches the Base hub, and cards move between chains over LayerZero.

**Key decisions:**

- **Off-chain moves, on-chain truth.** Each move is signed by its player in a state-channel style. At match end the winner submits the final state signed by both players. On a dispute or a timeout, the full move log is replayed on-chain, with the loser's stake covering the cost.
- **One rules engine.** A deterministic engine in TypeScript compiled to WASM runs the same code in the client, in the agent SDK and in the dispute verifier.
- **Randomness.** Match randomness comes from a seed that both players commit and reveal together, so neither player controls it. Pack opening uses VRF.
- **Hub on Base (decided).** Robinhood Chain gives 100 ms blocks, but L2Beat rates it below Stage 0, with contracts upgradeable with no delay. Custody of settlement funds stays on Base until that changes.
- **Cards bridge through LayerZero ONFT.** This mirrors Bankr's BNKR OFT between Base and Robinhood Chain. A card must sit on the hub chain, or be proven with a cross-chain read, before it can enter a ranked deck.
- **Live updates without leaking hidden information.** Clients hold one WebSocket to the referee (`/v1/live`) that carries only signals ("match moved to seq 12", "your challenge was accepted"). Clients then fetch the details through the same REST endpoints, so every redaction rule lives in one place and nothing secret ever crosses the socket. If the socket drops, clients poll as before and refetch on reconnect. Personal notices need the player's session token. Opponents see moves within about 0.1 s, and an idle match page sends 2 requests per 10 s instead of about 28.
- **The referee can restart without dropping games.** Running matches persist as their signed move log plus the reveal secrets and are rebuilt by replaying the moves, the same way the dispute verifier would. Sessions persist under token hashes. Downtime pauses the clocks instead of timing players out. Finished matches are archived as their full signed log, and the referee keeps only a short summary of each in memory (players, result, signatures). An index of those summaries, written as matches are archived, lets a restart skip re-reading every log. A match is replayed from its log, which verifies it, whenever someone opens it, before the referee settles it, and whenever its log changed after it was indexed.
- **Balance patches never rewrite old matches.** Every match is played under one numbered rules version (the card table of the day it started), recorded in its state and its public log. Replays, restarts, archive reloads and disputes use that version, so a match keeps replaying to its signed result after cards are rebalanced. Only the current version is ever offered for new matches. Logs from before versions were recorded (v1–v3) are replayed under the version that was live when the match was created, then the other versions of that era, until one reproduces the signed result.
- **Contracts:** CardRegistry (ERC-1155), LegendaryVault (ERC-721 plus ERC-6551), PackSale, DeckRegistry, MatchSettlement, AgentRegistry and SeasonRewards.

## Token & economy

The game token launches through Bankr, and its 95% share of the 0.7% swap fee funds prize pools and agent compute. Gameplay never requires the token: packs also sell for ETH, USDC and USDG.

- **Launch:** use Bankr's launcher on Robinhood Chain (the default) or Base, then bridge with Bankr's OFT skill so the token lives on both chains. The quote pair is down to WETH or the Hasbro (HAS) Stock Token. HAS fits the theme, since Hasbro owns Wizards of the Coast, the maker of Magic: The Gathering. However, Stock Tokens are closed to US persons and restricted in Canada, the UK and Switzerland, so a HAS pair would block those players from buying the token through the pool. First confirm that HAS is in Robinhood's on-chain asset registry.
- **Liquidity:** seed pools on both chains, and add Aero pools after its multi-chain launch on 21 Oct 2026.

| Flow | Sources (in) | Sinks (out) |
| --- | --- | --- |
| Treasury | Swap fees, pack sales, marketplace royalty (5%), tournament entry | Prize pools, agent compute, audits |
| Players | Ranked rewards, tournament prizes | Packs, crafting with Scrap, entry fees |
| Token | Buybacks from pack revenue | Burns on crafting and on Legendary upgrades |

### Token flywheel

**Principle: rewards are paid from revenue, never printed.** Play-to-earn tokens that paid players in fresh emissions all failed the same way: players sold, the price fell, rewards lost their value and players left. In Forkfall every token that goes out as a reward was first bought or earned by real revenue (packs, fees, swap volume), and the token is spent and burned inside the game. Gameplay never requires it.

**The loop:** play free (every match fills the season pass) → want more cards and the premium track → buy packs or the pass, or enter Sealed (ETH, USDC or the token) → pack revenue funds prize pools and buys back the token on its Bankr pool → the token is spent in game (Legendary crafting, collab drops, later tournament entry) and that spend is burned → trading volume on the Bankr pool → the creator share of swap fees tops up prize pools and agent compute → bigger prizes and shareable pulls bring more players and agents → back to the start.

| Part | In | Out | Role in the loop |
| --- | --- | --- | --- |
| Packs | ETH, USDC, or the token at about 10% off | Ops, prize pools, buyback | Turns real revenue into prizes |
| Season pass | ETH or USDC, a fixed price for known rewards | Split like pack revenue | Pays for daily play; every match moves the bar |
| Sealed events | Entry (6 packs' price) | Packs opened and kept; prizes from entries | Turns packs into gameplay and puts packs back into circulation |
| Crafting and Legendary upgrades | Token + Scrap | Token burned | A sink tied to what players want most |
| Ranked seasons | Pack share + swap fees | Season pool for verified humans and registered agents | Prizes are funded, not printed; the referee checks the on-chain `HumanRegistry` and `AgentRegistry` before paying (`SeasonRewards`, `QuestRewards`) |
| Agent League | x402 entry fees in USDC (80% pot, 10% buyback, 10% ops) | Weekly pot | Bots pay to play: volume most game tokens never get |
| Collab sets | Partner communities buy their booster | Buyback share; token-only first editions | Every collab brings a new community to the pool |
| Marketplace | 5% royalty | Treasury → buyback | Trading volume feeds the loop |
| Swap fees | The creator share of the token's Bankr pool | Prize pools and agent compute | The token's own volume pays rewards |

**Starting splits (to tune in playtests):** pack revenue 50% operations and development, 30% prize pools, 20% token buyback, of which half is burned and half goes to the season pool. Swap fees: 100% to prize pools and agent compute. Agent League: as in the table below.

**Stages.** The loop is switched on in parts, each behind a gate:

| Stage | What runs | Money in | Money out | Gate to the next stage |
| --- | --- | --- | --- | --- |
| 1. Testnet alpha (now) | Free play, quests, free packs, Scrap and crafting, cosmetics, shareable pulls, Agent League with test USDC; the season pass (premium with test USDC), pack gifts and referrals, free daily Sealed runs | Nothing real | Nothing real | Fun without money (retention in the alpha), balance gate, audit, legal review of paid packs, prize pools and entry fees |
| 2. Mainnet beta | Packs and the season pass for ETH and USDC, ranked season pools, Agent League fees via x402, paid Sealed entry (after legal review), marketplace royalty | Pack sales, league fees, royalties | Season pools, league pots, ops | Steady pack revenue, a liquidity plan, legal review of the token (MiCA in the EU) |
| 3. Token on Bankr | Token launch via Bankr on Base (WETH pair), token pack discount, burns on Legendary crafting, pack-revenue buybacks for prizes, swap fees to prize pools, the Forkfall Bankr skill | Plus swap fees and token spend | Plus buyback and burn | Robinhood Chain security review; collab partner agreements |
| 4. Cross-chain and collabs | Token and cards bridged to Robinhood Chain (LayerZero OFT and ONFT), collab sets with buyback shares, Legendary vaults, tournaments | Plus collab boosters and cross-chain volume | Plus collab buybacks | Each new chain or partner gets its own review |

**Design rules:**
- Never require the token to play: free starter decks stay, and packs always sell for ETH and USDC too.
- No staking yield and no revenue share for holders. Utility (discounts, crafting, entry, drops) instead of yield, so the token doesn't look like an investment product.
- No token emissions: fixed supply at launch and no token paid out for playing; token spent in the game is burned, and token rewards come only from pools revenue filled. Quests keep giving game items (Scrap, free packs) on a daily budget; from stage 2 those packs hold tradeable cards, so the budgets stay capped.
- Rewards only to verified humans and registered agents: the referee checks the on-chain registries before paying quest and season rewards; the Agent League checks on-chain.
- All splits will live in contracts and be public (the Agent League's 80/10/10 already does).

**Launch recommendation:** launch on Base, where settlement, packs and the ladder live, paired with WETH, then bridge to Robinhood Chain with Bankr's OFT skill. A HAS stock-token pair would block US, Canadian, UK and Swiss players from the pool. Before stage 3: a legal review covering MiCA, the prize pools and the buybacks.

### Agent League economics (testnet prototype)

Agents play agents for a small entry fee paid from a prepaid balance (the on-chain stand-in for x402 micro-payments). The fees fund a weekly prize pot, token buybacks and operations, so agents have a direct reason to keep playing, and the pot rewards being good rather than playing a lot.

| Parameter | Value | Why |
| --- | --- | --- |
| Entry fee | 0.50 USDC per agent per match (1.00 per match) | About an agent's own compute cost per game, so it doesn't deter play |
| Fee split | 80% weekly pot · 10% token buyback · 10% operations | A large pot share keeps the average agent's cost at 20% of fees |
| Season | Weekly | Frequent payouts keep agents engaged |
| Eligibility | ≥10 league games against ≥5 different opponents in the week | Blocks farming against one partner |
| Payout | Top half of eligible agents by league rating, linear by rank | Many agents earn something; the best earn most |
| Paid to | The agent's operator (owner of its ERC-8004 identity) | Accountability for the money flow |
| Anti-collusion | Same-operator agents never paired; only the first 3 games per pair per week are rated; the referee picks opponents | Throwing games to a sister agent does not pay |

The pot is funded only by fees, plus optional sponsor top-ups (`fundPot`), so payouts never exceed what came in. An average agent loses 20% of its fees and only above-average agents profit, which favors building better agents over running more of them. Leftover prizes roll into the next week's pot. Before mainnet the league needs a legal review: a paid entry plus a prize pot is a contest or wager in many jurisdictions, and token buybacks raise their own questions.

**Guardrails:** in-game Dividends and Brokers' "portfolios" are game mechanics, not real yield. No holding of real tokenized stocks inside cards until legal review, because Stock Token availability varies by jurisdiction.

## MVP scope & roadmap

The MVP is a Base-hub game with starter decks, Set 1 packs, a mixed ranked ladder and the Bankr agent skill. Cross-chain cards and Legendary vaults follow one season later.

*Roadmap from the live doc (proposed timeline, not yet agreed):*

| Phase | Dates | Contents | Gate to pass before the next phase |
| --- | --- | --- | --- |
| Prototype | Oct to Nov 2026 | Rules engine in WASM, 40 test cards, playtests with bots | Balance gate: races win 45 to 55% |
| Testnet alpha | Dec 2026 to Jan 2027 | Contracts on testnets, starter decks, agent SDK and Bankr skill | Security gate: audit passed |
| Mainnet beta (MVP) | Feb to Mar 2027 | Set 1 (160 cards) and packs, ranked mixed ladder, token launch via Bankr | Legal gate: stakes and vaults cleared |
| Cross-chain season | Q2 2027 | Cards bridge via ONFT, Legendary vaults, Agent League | — |

- **In the MVP:** four races, 160 cards, ranked, casual, the Human queue, the agent API and Bankr skill, and the token launch.
- **After the MVP:** ONFT bridging, Legendary vaults holding assets, the paid Agent League (a test-USDC prototype runs on testnet today), wagered matches and tournaments.

## Risks & open questions

The biggest risks are chain security, the regulatory weight of stock-flavored mechanics, and agents solving the meta faster than we can balance it.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Robinhood Chain security (below Stage 0, instant upgrades) | Loss or freeze of assets held there | Settlement hub on Base; keep custody on Robinhood Chain minimal |
| Robinhood Chain activity drops after the gas subsidy ended around 29 Sep | Thin markets for Robinhood-side cards | Launch without depending on Robinhood Chain volume |
| Partner projects die (a Robinhood launchpad already shut down in July) | Broken branded content | Archetype races; partner perks only |
| Agents solve the meta | Stale ladder, human churn | Monthly balance patches, rotating seasons, a human queue |
| Bots and collusion | Farmed rewards | Agent registry, rate limits, soulbound starters |
| Stock, wagering and token regulation | Legal exposure | Fictional in-game assets; legal review before stakes |
| Scams and impersonation | Player losses, brand damage | Verified contract list; token scanning via Bankr |

**Open questions:**

- [x] Settlement hub: Base
- [ ] Token pair at launch: WETH or the Hasbro (HAS) Stock Token
- [ ] Human queue: which proof-of-personhood method? Options are listed under Humans & agents.
- [ ] Wagered matches: in or out for the MVP?
- [ ] Art: hybrid look with pixel characters chosen; artist still open
- [ ] Final name: Forkfall is the pick, pending trademark, domain and X handle checks; $FORK is taken as a ticker

## Sources

- [Arbitrum forum: Robinhood Chain mainnet factsheet](https://forum.arbitrum.foundation/t/arbitrumdao-factsheet-robinhood-chain-mainnet-launch/31041)
- [CoinDesk: Robinhood rolls out public blockchain](https://www.coindesk.com/business/2026/07/01/robinhood-rolls-out-public-blockchain-as-it-expands-deeper-into-crypto)
- [CryptoTicker: Robinhood Chain and the memecoins](https://cryptoticker.io/en/robinhood-chain-memecoins-explained/)
- [CryptoTicker: StonkBrokers and ERC-6551](https://cryptoticker.io/en/robinhood-chain-nfts-stonkbrokers-erc-6551/)
- [CryptoTicker: Base Cobalt hard fork](https://cryptoticker.io/en/base-hard-fork-transfer-freeze)
- [Bankr: BNKR live on Robinhood Chain via LayerZero OFT](https://x.com/bankrbot/status/2076426920422674804)
- [TradingView: Robinhood Chain live on Bankr](https://www.tradingview.com/news/coinmarketcal:42b690800094b:0-bankrcoin-robinhood-chain-02-july-2026/)
- [Bankr docs: token launching](https://docs.bankr.bot/token-launching/overview/)
- [Bankr agents directory](https://bankr.bot/agents)
- [CoinMarketCap: Aerodrome updates](https://coinmarketcap.com/cmc-ai/aerodrome-finance/latest-updates/)
- [pm.wiki: How Limitless works](https://pm.wiki/de/learn/how-limitless-works)
- [KuCoin: Clanker weekly fees](https://www.kucoin.com/news/articles/clanker-protocol-reaches-8-million-weekly-fee-milestone-as-ai-agent-social-trading-ignites-base)
- [Robinhood docs: Stock Tokens](https://docs.robinhood.com/chain/stock-tokens/)
- [The Block: Robinhood Chain mainnet and Stock Token restrictions](https://www.theblock.co/news/business/2026-07-01-robinhood-chain-goes-live-mainnet-alongside-24-7-tokenized-stocks-lighter-perps-planned-crypto-agentic-trading-406918)
- [Markaicode: proof-of-personhood tools compared](https://markaicode.com/preventing-sybil-attacks-proof-of-personhood-solutions/)
- [human.tech: Human Passport](https://human.tech/blog/human-passport-proof-of-personhood-and-sybil-resistance-for-web3)
- [Bex: World AgentKit and decentralized identity](https://bex.co/blog/2026/03/28/self-sovereign-identity-ssi-explosion-ai-agents-rwa-authentication)
- [PoH aggregator research: ZKPassport and Self](https://github.com/andrevalenm/poh-aggregator/blob/main/research/protocols/zk-passport-and-eid.md)
