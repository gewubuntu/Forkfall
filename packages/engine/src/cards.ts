import type { CardDef, CardSet, Faction, PredictionCondition, Race, Rarity } from './types.ts';

/** Token ids live outside the collectible range and never exist on-chain. */
export const TOKEN_DRONE = 1000;
export const TOKEN_BOND = 1001;
export const TOKEN_TACO = 1002;

/**
 * The core set: the 40 prototype cards (ids 1–40: 8 per race + 8 neutral) and Set 1 cards added in batches
 * (ids 49–168), the Poncho collab set (ids 41–48, neutral, from Base) and 3 tokens. Collectible ids map 1:1 to
 * ERC-1155 token ids in CardRegistry.
 * All numbers are playtest starting values.
 */
export const CARDS: CardDef[] = [
  // ─── Agents (Base) ─────────────────────────────────────────────
  {
    id: 1, slug: 'launch-bot', name: 'Launch Bot', faction: 'agents', chain: 'base', type: 'unit',
    cost: 2, attack: 2, health: 2, rarity: 'common', keywords: [], collectible: true,
    text: 'Deploy 1.', onPlay: [{ k: 'deploy', n: 1 }],
  },
  {
    id: 2, slug: 'compute-node', name: 'Compute Node', faction: 'agents', chain: 'base', type: 'unit',
    cost: 1, attack: 1, health: 2, rarity: 'common', keywords: [], collectible: true,
    text: 'Compute 1: your next card costs 1 less.', onPlay: [{ k: 'compute', n: 1 }],
  },
  {
    id: 3, slug: 'cron-job', name: 'Cron Job', faction: 'agents', chain: 'base', type: 'action',
    cost: 2, rarity: 'common', keywords: [], collectible: true,
    text: 'Draw 1. Automate: at the start of your next turn, deal 2 damage to a random enemy unit (or the enemy Treasury).',
    onPlay: [{ k: 'draw', n: 1 }, { k: 'automate', effects: [{ k: 'damage', to: 'randomEnemyUnitOrTreasury', n: 2 }] }],
  },
  {
    id: 4, slug: 'sentry-drone', name: 'Sentry Drone', faction: 'agents', chain: 'base', type: 'unit',
    cost: 3, attack: 2, health: 3, rarity: 'common', keywords: ['guard', 'firewall'], collectible: true,
    text: 'Guard. Firewall: whenever an enemy unit is summoned, deal 1 damage to it.',
  },
  {
    id: 5, slug: 'swarm-deployer', name: 'Swarm Deployer', faction: 'agents', chain: 'base', type: 'unit',
    cost: 4, attack: 3, health: 3, rarity: 'uncommon', keywords: [], collectible: true,
    text: 'Deploy 2.', onPlay: [{ k: 'deploy', n: 2 }],
  },
  {
    id: 6, slug: 'firewall', name: 'Firewall', faction: 'agents', chain: 'base', type: 'asset',
    cost: 1, rarity: 'uncommon', keywords: ['firewall'], collectible: true,
    text: 'Asset. Firewall: whenever an enemy unit is summoned, deal 1 damage to it.',
  },
  {
    id: 7, slug: 'mainframe', name: 'Mainframe', faction: 'agents', chain: 'base', type: 'unit',
    cost: 6, attack: 5, health: 6, rarity: 'rare', keywords: [], collectible: true,
    text: 'At the start of your turn, Deploy 1.', startOfTurn: [{ k: 'deploy', n: 1 }],
  },
  {
    id: 8, slug: 'the-launcher', name: 'The Launcher', faction: 'agents', chain: 'base', type: 'unit',
    cost: 8, attack: 6, health: 6, rarity: 'legendary', keywords: [], collectible: true,
    text: 'Deploy 3. Automate: at the start of your next turn, give all friendly units +1/+1.',
    onPlay: [{ k: 'deploy', n: 3 }, { k: 'automate', effects: [{ k: 'buff', to: 'allFriendly', atk: 1, hp: 1 }] }],
  },

  // ─── Prophets (Base) ───────────────────────────────────────────
  {
    id: 9, slug: 'tea-leaves', name: 'Tea Leaves', faction: 'prophets', chain: 'base', type: 'prediction',
    cost: 1, rarity: 'common', keywords: [], collectible: true,
    text: 'Foresee. Correct: deal 2 damage per Odds tier to the enemy Treasury. Backfire: take 1.',
    prediction: { damagePerTier: 2, backfire: 1 },
  },
  {
    id: 10, slug: 'seers-acolyte', name: "Seer's Acolyte", faction: 'prophets', chain: 'base', type: 'unit',
    cost: 2, attack: 3, health: 3, rarity: 'common', keywords: [], collectible: true,
    text: 'When one of your predictions comes true, gain +1/+1.',
    onPredictionHit: [{ k: 'buff', to: 'self', atk: 1, hp: 1 }],
  },
  {
    id: 11, slug: 'star-chart', name: 'Star Chart', faction: 'prophets', chain: 'base', type: 'prediction',
    cost: 2, rarity: 'common', keywords: [], collectible: true,
    text: 'Foresee. Correct: draw 1 card per Odds tier and deal 1 damage per tier. Backfire: take 1.',
    prediction: { drawPerTier: 1, damagePerTier: 1, backfire: 1 },
  },
  {
    id: 12, slug: 'oracle-guard', name: 'Oracle Guard', faction: 'prophets', chain: 'base', type: 'unit',
    cost: 3, attack: 3, health: 4, rarity: 'common', keywords: ['guard'], collectible: true,
    text: 'Guard. If you have an active prediction, draw 1.', onPlay: [{ k: 'drawIfPrediction', n: 1 }],
  },
  {
    id: 13, slug: 'called-it', name: 'Called It', faction: 'prophets', chain: 'base', type: 'action',
    cost: 2, rarity: 'uncommon', keywords: [], collectible: true, target: 'enemyUnit',
    text: 'Deal 3 damage to an enemy unit, or 5 if you have an active prediction.',
    onPlay: [{ k: 'damage', to: 'chosen', n: 3, nIfPrediction: 5 }],
  },
  {
    id: 14, slug: 'market-seer', name: 'Market Seer', faction: 'prophets', chain: 'base', type: 'unit',
    cost: 5, attack: 4, health: 6, rarity: 'uncommon', keywords: ['predictionBonus'], collectible: true,
    text: 'Your predictions resolve one Odds tier higher.',
  },
  {
    id: 15, slug: 'prophecy-of-ruin', name: 'Prophecy of Ruin', faction: 'prophets', chain: 'base', type: 'prediction',
    cost: 4, rarity: 'rare', keywords: [], collectible: true,
    text: 'Foresee. Correct: deal 3 damage per Odds tier to the enemy Treasury. Backfire: take 3.',
    prediction: { damagePerTier: 3, backfire: 3 },
  },
  {
    id: 16, slug: 'the-all-seeing-eye', name: 'The All-Seeing Eye', faction: 'prophets', chain: 'base', type: 'unit',
    cost: 7, attack: 5, health: 7, rarity: 'legendary', keywords: ['noBackfire'], collectible: true,
    text: 'Your predictions never backfire. Draw 2.', onPlay: [{ k: 'draw', n: 2 }],
  },

  // ─── Brokers (Robinhood Chain) ─────────────────────────────────
  {
    id: 17, slug: 'intern', name: 'Intern', faction: 'brokers', chain: 'robinhood', type: 'unit',
    cost: 1, attack: 1, health: 1, rarity: 'common', keywords: ['hold'], collectible: true,
    text: 'Hold.',
  },
  {
    id: 18, slug: 'bond-desk', name: 'Bond Desk', faction: 'brokers', chain: 'robinhood', type: 'unit',
    cost: 2, attack: 0, health: 3, rarity: 'common', keywords: ['hold', 'guard'], collectible: true,
    text: 'Hold. Guard.',
  },
  {
    id: 19, slug: 'analyst', name: 'Analyst', faction: 'brokers', chain: 'robinhood', type: 'unit',
    cost: 3, attack: 2, health: 2, rarity: 'common', keywords: ['hold'], collectible: true,
    text: 'Hold. Dividend: draw 1.', dividend: [{ k: 'draw', n: 1 }],
  },
  {
    id: 20, slug: 'index-fund', name: 'Index Fund', faction: 'brokers', chain: 'robinhood', type: 'unit',
    cost: 4, attack: 3, health: 4, rarity: 'common', keywords: ['hold'], collectible: true,
    text: 'Hold. Dividend: gain 1 Gas.', dividend: [{ k: 'gainGas', n: 1 }],
  },
  {
    id: 21, slug: 'portfolio-manager', name: 'Portfolio Manager', faction: 'brokers', chain: 'robinhood', type: 'unit',
    cost: 4, attack: 2, health: 3, rarity: 'uncommon', keywords: ['hold'], collectible: true,
    text: 'Hold. Portfolio: holds 2 Bonds (2/2) that drop to the board when this dies.',
    portfolio: [TOKEN_BOND, TOKEN_BOND],
  },
  {
    id: 22, slug: 'compound-interest', name: 'Compound Interest', faction: 'brokers', chain: 'robinhood', type: 'action',
    cost: 2, rarity: 'uncommon', keywords: [], collectible: true, target: 'friendlyUnit',
    text: 'Give a friendly unit +2/+2 and Hold.',
    onPlay: [{ k: 'buff', to: 'chosen', atk: 2, hp: 2, addKeywords: ['hold'] }],
  },
  {
    id: 23, slug: 'trust-vault', name: 'Trust Vault', faction: 'brokers', chain: 'robinhood', type: 'unit',
    cost: 6, attack: 3, health: 6, rarity: 'rare', keywords: ['guard', 'hold'], collectible: true,
    text: 'Guard. Hold. Portfolio: holds 2 Bonds.', portfolio: [TOKEN_BOND, TOKEN_BOND],
  },
  {
    id: 24, slug: 'the-whale', name: 'The Whale', faction: 'brokers', chain: 'robinhood', type: 'unit',
    cost: 8, attack: 7, health: 9, rarity: 'legendary', keywords: ['hold'], collectible: true,
    text: 'Hold. Dividend: draw 1 and gain 1 Gas.', dividend: [{ k: 'draw', n: 1 }, { k: 'gainGas', n: 1 }],
  },

  // ─── Degens (Robinhood Chain) ──────────────────────────────────
  {
    id: 25, slug: 'meme-critter', name: 'Meme Critter', faction: 'degens', chain: 'robinhood', type: 'unit',
    cost: 1, attack: 1, health: 1, rarity: 'common', keywords: ['swarm'], collectible: true,
    text: 'Swarm: +1 attack for each other friendly Swarm unit.',
  },
  {
    id: 26, slug: 'paper-hands', name: 'Paper Hands', faction: 'degens', chain: 'robinhood', type: 'unit',
    cost: 2, attack: 2, health: 2, rarity: 'common', keywords: ['rush'], collectible: true,
    text: 'Rush.',
  },
  {
    id: 27, slug: 'pump-frog', name: 'Pump Frog', faction: 'degens', chain: 'robinhood', type: 'unit',
    cost: 2, attack: 1, health: 2, rarity: 'common', keywords: ['swarm', 'ape'], collectible: true,
    text: 'Swarm. Ape. Pump: gain a random stat boost.', onPlay: [{ k: 'pump', to: 'self' }],
  },
  {
    id: 28, slug: 'ape-in', name: 'Ape In', faction: 'degens', chain: 'robinhood', type: 'action',
    cost: 1, rarity: 'common', keywords: [], collectible: true, target: 'friendlyUnit',
    text: 'Pump a friendly unit. It gains Rush this turn.',
    onPlay: [{ k: 'pump', to: 'chosen' }, { k: 'grantRush', to: 'chosen' }],
  },
  {
    id: 29, slug: 'rug-pull', name: 'Rug Pull', faction: 'degens', chain: 'robinhood', type: 'action',
    cost: 1, rarity: 'uncommon', keywords: [], collectible: true, target: 'friendlyUnit',
    text: "Sacrifice a friendly unit. Deal its attack +2 to the enemy Treasury.", onPlay: [{ k: 'rug', bonus: 2 }],
  },
  {
    id: 30, slug: 'hype-man', name: 'Hype Man', faction: 'degens', chain: 'robinhood', type: 'unit',
    cost: 3, attack: 2, health: 3, rarity: 'uncommon', keywords: ['swarm', 'ape'], collectible: true,
    text: 'Swarm. Ape. Give all friendly Swarm units +1 attack.',
    onPlay: [{ k: 'buff', to: 'allFriendlySwarm', atk: 1, hp: 0 }],
  },
  {
    id: 31, slug: 'leverage', name: 'Leverage', faction: 'degens', chain: 'robinhood', type: 'action',
    cost: 2, rarity: 'rare', keywords: ['ape'], collectible: true, target: 'friendlyUnit',
    text: "Ape. Double a friendly unit's attack.", onPlay: [{ k: 'doubleAttack', to: 'chosen' }],
  },
  {
    id: 32, slug: 'sticker-dragon', name: 'Sticker Dragon', faction: 'degens', chain: 'robinhood', type: 'unit',
    cost: 6, attack: 6, health: 5, rarity: 'legendary', keywords: ['rush', 'ape'], collectible: true,
    text: 'Rush. Ape. Pump all friendly units.', onPlay: [{ k: 'pump', to: 'allFriendly' }],
  },

  // ─── Neutral ───────────────────────────────────────────────────
  {
    id: 33, slug: 'cold-wallet', name: 'Cold Wallet', faction: 'neutral', chain: 'any', type: 'unit',
    cost: 2, attack: 1, health: 4, rarity: 'common', keywords: ['guard'], collectible: true,
    text: 'Guard.',
  },
  {
    id: 34, slug: 'validator', name: 'Validator', faction: 'neutral', chain: 'any', type: 'unit',
    cost: 3, attack: 3, health: 3, rarity: 'common', keywords: [], collectible: true,
    text: '',
  },
  {
    id: 35, slug: 'airdrop', name: 'Airdrop', faction: 'neutral', chain: 'any', type: 'action',
    cost: 2, rarity: 'common', keywords: [], collectible: true,
    text: 'Draw 2.', onPlay: [{ k: 'draw', n: 2 }],
  },
  {
    id: 36, slug: 'liquidator', name: 'Liquidator', faction: 'neutral', chain: 'any', type: 'action',
    cost: 3, rarity: 'common', keywords: [], collectible: true, target: 'anyUnit',
    text: 'Deal 3 damage to a unit.', onPlay: [{ k: 'damage', to: 'chosen', n: 3 }],
  },
  {
    id: 37, slug: 'bridge-runner', name: 'Bridge Runner', faction: 'neutral', chain: 'any', type: 'unit',
    cost: 2, attack: 2, health: 1, rarity: 'common', keywords: ['rush'], collectible: true,
    text: 'Rush.',
  },
  {
    id: 38, slug: 'mev-searcher', name: 'MEV Searcher', faction: 'neutral', chain: 'any', type: 'unit',
    cost: 4, attack: 4, health: 3, rarity: 'uncommon', keywords: ['rush'], collectible: true,
    text: 'Rush.',
  },
  {
    id: 39, slug: 'hard-fork', name: 'Hard Fork', faction: 'neutral', chain: 'any', type: 'action',
    cost: 5, rarity: 'uncommon', keywords: [], collectible: true,
    text: 'Deal 2 damage to every unit.', onPlay: [{ k: 'damage', to: 'allUnits', n: 2 }],
  },
  {
    id: 40, slug: 'genesis-block', name: 'Genesis Block', faction: 'neutral', chain: 'any', type: 'unit',
    cost: 5, attack: 5, health: 5, rarity: 'rare', keywords: ['guard'], collectible: true,
    text: 'Guard.',
  },

  // ─── Poncho set (collab with Poncho, the cutest cat on Base) ───
  // Neutral cards any race can play, themed on Poncho and tacos. Never in starter decks.
  {
    id: 41, slug: 'poncho-kitten', name: 'Poncho Kitten', faction: 'neutral', chain: 'base', set: 'poncho', type: 'unit',
    cost: 1, attack: 1, health: 1, rarity: 'common', keywords: [], collectible: true,
    text: 'Add a Taco to your hand.', onPlay: [{ k: 'addToHand', card: TOKEN_TACO, n: 1 }],
  },
  {
    id: 42, slug: 'taco-tuesday', name: 'Taco Tuesday', faction: 'neutral', chain: 'base', set: 'poncho', type: 'action',
    cost: 2, rarity: 'common', keywords: [], collectible: true,
    text: 'Add 2 Tacos to your hand.', onPlay: [{ k: 'addToHand', card: TOKEN_TACO, n: 2 }],
  },
  {
    id: 43, slug: 'salsa-slinger', name: 'Salsa Slinger', faction: 'neutral', chain: 'base', set: 'poncho', type: 'unit',
    cost: 3, attack: 2, health: 2, rarity: 'common', keywords: [], collectible: true,
    text: 'Deal 2 damage to a random enemy unit (or the enemy Treasury).',
    onPlay: [{ k: 'damage', to: 'randomEnemyUnitOrTreasury', n: 2 }],
  },
  {
    id: 44, slug: 'sombrero-sentry', name: 'Sombrero Sentry', faction: 'neutral', chain: 'base', set: 'poncho', type: 'unit',
    cost: 3, attack: 2, health: 4, rarity: 'common', keywords: ['guard'], collectible: true,
    text: 'Guard. When this dies, add a Taco to your hand.', onDeath: [{ k: 'addToHand', card: TOKEN_TACO, n: 1 }],
  },
  {
    id: 45, slug: 'taco-truck', name: 'Taco Truck', faction: 'neutral', chain: 'base', set: 'poncho', type: 'unit',
    cost: 4, attack: 2, health: 5, rarity: 'uncommon', keywords: [], collectible: true,
    text: 'At the start of your turn, add a Taco to your hand.', startOfTurn: [{ k: 'addToHand', card: TOKEN_TACO, n: 1 }],
  },
  {
    id: 46, slug: 'poncho-posse', name: 'Poncho Posse', faction: 'neutral', chain: 'base', set: 'poncho', type: 'unit',
    cost: 4, attack: 3, health: 3, rarity: 'uncommon', keywords: [], collectible: true,
    text: 'Give all friendly units +1/+1.', onPlay: [{ k: 'buff', to: 'allFriendly', atk: 1, hp: 1 }],
  },
  {
    id: 47, slug: 'mariachi-cat', name: 'Mariachi Cat', faction: 'neutral', chain: 'base', set: 'poncho', type: 'unit',
    cost: 5, attack: 4, health: 4, rarity: 'rare', keywords: ['rush'], collectible: true,
    text: 'Rush. Add 2 Tacos to your hand.', onPlay: [{ k: 'addToHand', card: TOKEN_TACO, n: 2 }],
  },
  {
    id: 48, slug: 'poncho', name: 'Poncho, Cutest Cat on Base', faction: 'neutral', chain: 'base', set: 'poncho', type: 'unit',
    cost: 7, attack: 5, health: 6, rarity: 'legendary', keywords: ['guard'], collectible: true,
    text: 'Guard. Add 2 Tacos to your hand. At the start of your turn, give all friendly units +1/+1.',
    onPlay: [{ k: 'addToHand', card: TOKEN_TACO, n: 2 }], startOfTurn: [{ k: 'buff', to: 'allFriendly', atk: 1, hp: 1 }],
  },

  // ─── Set 1 · Prophets, batch 1 ─────────────────────────────────
  {
    id: 49, slug: 'fortune-cookie', name: 'Fortune Cookie', faction: 'prophets', chain: 'base', type: 'prediction',
    cost: 1, rarity: 'common', keywords: [], collectible: true,
    text: 'Foresee. Correct: draw 1 card per Odds tier. Backfire: take 1.',
    prediction: { drawPerTier: 1, backfire: 1 },
  },
  {
    id: 50, slug: 'street-oracle', name: 'Street Oracle', faction: 'prophets', chain: 'base', type: 'unit',
    cost: 1, attack: 1, health: 2, rarity: 'common', keywords: [], collectible: true,
    text: 'When one of your predictions comes true, deal 1 damage to the enemy Treasury.',
    onPredictionHit: [{ k: 'damage', to: 'enemyTreasury', n: 1 }],
  },
  {
    id: 51, slug: 'second-sight', name: 'Second Sight', faction: 'prophets', chain: 'base', type: 'action',
    cost: 2, rarity: 'common', keywords: [], collectible: true,
    text: 'Draw 1, plus 1 more if you have an active prediction.',
    onPlay: [{ k: 'draw', n: 1 }, { k: 'drawIfPrediction', n: 1 }],
  },
  {
    id: 52, slug: 'hedge-prophet', name: 'Hedge Prophet', faction: 'prophets', chain: 'base', type: 'unit',
    cost: 3, attack: 2, health: 4, rarity: 'common', keywords: ['guard'], collectible: true,
    text: 'Guard. When this dies, draw 1.', onDeath: [{ k: 'draw', n: 1 }],
  },
  {
    id: 53, slug: 'augur', name: 'Augur', faction: 'prophets', chain: 'base', type: 'unit',
    cost: 4, attack: 4, health: 4, rarity: 'common', keywords: [], collectible: true, target: 'enemyUnit',
    text: 'If you have an active prediction, deal 2 damage to an enemy unit.',
    onPlay: [{ k: 'damage', to: 'chosen', n: 0, nIfPrediction: 2 }],
  },
  {
    id: 54, slug: 'contrarian', name: 'Contrarian', faction: 'prophets', chain: 'base', type: 'action',
    cost: 2, rarity: 'uncommon', keywords: [], collectible: true, target: 'enemyUnit',
    text: 'Deal 2 damage to an enemy unit. If you have an active prediction, draw 1.',
    onPlay: [{ k: 'damage', to: 'chosen', n: 2 }, { k: 'drawIfPrediction', n: 1 }],
  },
  {
    id: 55, slug: 'seers-circle', name: "Seers' Circle", faction: 'prophets', chain: 'base', type: 'unit',
    cost: 4, attack: 3, health: 5, rarity: 'uncommon', keywords: [], collectible: true,
    text: 'When one of your predictions comes true, give all friendly units +1/+1.',
    onPredictionHit: [{ k: 'buff', to: 'allFriendly', atk: 1, hp: 1 }],
  },
  {
    id: 56, slug: 'self-fulfilling-prophecy', name: 'Self-Fulfilling Prophecy', faction: 'prophets', chain: 'base', type: 'prediction',
    cost: 3, rarity: 'uncommon', keywords: [], collectible: true,
    text: 'Foresee. Correct: deal 2 damage and draw 1 card per Odds tier. Backfire: take 2.',
    prediction: { damagePerTier: 2, drawPerTier: 1, backfire: 2 },
  },
  {
    id: 57, slug: 'the-long-bet', name: 'The Long Bet', faction: 'prophets', chain: 'base', type: 'unit',
    cost: 6, attack: 5, health: 6, rarity: 'rare', keywords: [], collectible: true,
    text: 'When one of your predictions comes true, deal 3 damage to the enemy Treasury.',
    onPredictionHit: [{ k: 'damage', to: 'enemyTreasury', n: 3 }],
  },

  // ─── Set 1 · Agents ────────────────────────────────────────────
  {
    id: 58, slug: 'script-kiddie', name: 'Script Kiddie', faction: 'agents', chain: 'base', type: 'unit',
    cost: 1, attack: 1, health: 1, rarity: 'common', keywords: [], collectible: true,
    text: 'Deploy 1.', onPlay: [{ k: 'deploy', n: 1 }],
  },
  {
    id: 59, slug: 'seed-phrase', name: 'Seed Phrase', faction: 'agents', chain: 'base', type: 'action',
    cost: 1, rarity: 'common', keywords: [], collectible: true,
    text: 'Draw 1. Compute 1: your next card costs 1 less.', onPlay: [{ k: 'draw', n: 1 }, { k: 'compute', n: 1 }],
  },
  {
    id: 60, slug: 'ping', name: 'Ping', faction: 'agents', chain: 'base', type: 'action',
    cost: 1, rarity: 'common', keywords: [], collectible: true, target: 'anyUnit',
    text: 'Deal 1 damage to a unit. Automate: at the start of your next turn, deal 1 damage to a random enemy unit (or the enemy Treasury).',
    onPlay: [{ k: 'damage', to: 'chosen', n: 1 }, { k: 'automate', effects: [{ k: 'damage', to: 'randomEnemyUnitOrTreasury', n: 1 }] }],
  },
  {
    id: 61, slug: 'upgrade', name: 'Upgrade', faction: 'agents', chain: 'base', type: 'action',
    cost: 1, rarity: 'common', keywords: [], collectible: true, target: 'friendlyUnit',
    text: 'Give a friendly unit +2/+1.', onPlay: [{ k: 'buff', to: 'chosen', atk: 2, hp: 1 }],
  },
  {
    id: 62, slug: 'faucet-bot', name: 'Faucet Bot', faction: 'agents', chain: 'base', type: 'unit',
    cost: 2, attack: 2, health: 1, rarity: 'common', keywords: [], collectible: true,
    text: 'Automate: at the start of your next turn, Deploy 1.',
    onPlay: [{ k: 'automate', effects: [{ k: 'deploy', n: 1 }] }],
  },
  {
    id: 63, slug: 'gas-optimizer', name: 'Gas Optimizer', faction: 'agents', chain: 'base', type: 'unit',
    cost: 2, attack: 2, health: 2, rarity: 'common', keywords: [], collectible: true,
    text: 'Compute 1: your next card costs 1 less.', onPlay: [{ k: 'compute', n: 1 }],
  },
  {
    id: 64, slug: 'relay-node', name: 'Relay Node', faction: 'agents', chain: 'base', type: 'unit',
    cost: 2, attack: 1, health: 4, rarity: 'common', keywords: ['guard'], collectible: true,
    text: 'Guard. When this dies, Deploy 1.', onDeath: [{ k: 'deploy', n: 1 }],
  },
  {
    id: 65, slug: 'batch-job', name: 'Batch Job', faction: 'agents', chain: 'base', type: 'action',
    cost: 2, rarity: 'common', keywords: [], collectible: true,
    text: 'Deploy 2.', onPlay: [{ k: 'deploy', n: 2 }],
  },
  {
    id: 66, slug: 'keeper-bot', name: 'Keeper Bot', faction: 'agents', chain: 'base', type: 'unit',
    cost: 3, attack: 3, health: 2, rarity: 'common', keywords: [], collectible: true,
    text: 'Automate: at the start of your next turn, deal 2 damage to a random enemy unit (or the enemy Treasury).',
    onPlay: [{ k: 'automate', effects: [{ k: 'damage', to: 'randomEnemyUnitOrTreasury', n: 2 }] }],
  },
  {
    id: 67, slug: 'load-balancer', name: 'Load Balancer', faction: 'agents', chain: 'base', type: 'unit',
    cost: 3, attack: 2, health: 4, rarity: 'common', keywords: ['guard'], collectible: true,
    text: 'Guard. Deploy 1.', onPlay: [{ k: 'deploy', n: 1 }],
  },
  {
    id: 68, slug: 'indexer', name: 'Indexer', faction: 'agents', chain: 'base', type: 'unit',
    cost: 3, attack: 2, health: 3, rarity: 'common', keywords: [], collectible: true,
    text: 'Deploy 1. Compute 1: your next card costs 1 less.', onPlay: [{ k: 'deploy', n: 1 }, { k: 'compute', n: 1 }],
  },
  {
    id: 69, slug: 'drone-swarm', name: 'Drone Swarm', faction: 'agents', chain: 'base', type: 'action',
    cost: 4, rarity: 'common', keywords: [], collectible: true,
    text: 'Deploy 3.', onPlay: [{ k: 'deploy', n: 3 }],
  },
  {
    id: 70, slug: 'assembly-line', name: 'Assembly Line', faction: 'agents', chain: 'base', type: 'unit',
    cost: 5, attack: 3, health: 5, rarity: 'common', keywords: [], collectible: true,
    text: 'Deploy 2. Automate: at the start of your next turn, Deploy 1.',
    onPlay: [{ k: 'deploy', n: 2 }, { k: 'automate', effects: [{ k: 'deploy', n: 1 }] }],
  },
  {
    id: 71, slug: 'server-rack', name: 'Server Rack', faction: 'agents', chain: 'base', type: 'unit',
    cost: 5, attack: 4, health: 6, rarity: 'common', keywords: ['guard'], collectible: true,
    text: 'Guard.',
  },
  {
    id: 72, slug: 'autopilot', name: 'Autopilot', faction: 'agents', chain: 'base', type: 'action',
    cost: 2, rarity: 'uncommon', keywords: [], collectible: true,
    text: 'Automate: at the start of your next turn, draw 2.',
    onPlay: [{ k: 'automate', effects: [{ k: 'draw', n: 2 }] }],
  },
  {
    id: 73, slug: 'overclock', name: 'Overclock', faction: 'agents', chain: 'base', type: 'action',
    cost: 2, rarity: 'uncommon', keywords: [], collectible: true, target: 'friendlyUnit',
    text: 'Give a friendly unit +2/+2. It gains Rush this turn.',
    onPlay: [{ k: 'buff', to: 'chosen', atk: 2, hp: 2 }, { k: 'grantRush', to: 'chosen' }],
  },
  {
    id: 74, slug: 'hot-swap', name: 'Hot Swap', faction: 'agents', chain: 'base', type: 'action',
    cost: 2, rarity: 'uncommon', keywords: [], collectible: true,
    text: 'Draw 1. Compute 2: your next card costs 2 less.', onPlay: [{ k: 'draw', n: 1 }, { k: 'compute', n: 2 }],
  },
  {
    id: 75, slug: 'kill-switch', name: 'Kill Switch', faction: 'agents', chain: 'base', type: 'action',
    cost: 3, rarity: 'uncommon', keywords: [], collectible: true, target: 'anyUnit',
    text: 'Deal 3 damage to a unit. Automate: at the start of your next turn, deal 2 damage to a random enemy unit (or the enemy Treasury).',
    onPlay: [{ k: 'damage', to: 'chosen', n: 3 }, { k: 'automate', effects: [{ k: 'damage', to: 'randomEnemyUnitOrTreasury', n: 2 }] }],
  },
  {
    id: 76, slug: 'honeypot', name: 'Honeypot', faction: 'agents', chain: 'base', type: 'unit',
    cost: 3, attack: 2, health: 5, rarity: 'uncommon', keywords: ['guard', 'firewall'], collectible: true,
    text: 'Guard. Firewall: whenever an enemy unit is summoned, deal 1 damage to it.',
  },
  {
    id: 77, slug: 'botnet', name: 'Botnet', faction: 'agents', chain: 'base', type: 'unit',
    cost: 4, attack: 3, health: 3, rarity: 'uncommon', keywords: [], collectible: true,
    text: 'Give all friendly units +1 attack.', onPlay: [{ k: 'buff', to: 'allFriendly', atk: 1, hp: 0 }],
  },
  {
    id: 78, slug: 'cron-daemon', name: 'Cron Daemon', faction: 'agents', chain: 'base', type: 'unit',
    cost: 4, attack: 3, health: 4, rarity: 'uncommon', keywords: [], collectible: true,
    text: 'At the start of your turn, deal 1 damage to a random enemy unit (or the enemy Treasury).',
    startOfTurn: [{ k: 'damage', to: 'randomEnemyUnitOrTreasury', n: 1 }],
  },
  {
    id: 79, slug: 'fork-bomb', name: 'Fork Bomb', faction: 'agents', chain: 'base', type: 'action',
    cost: 5, rarity: 'uncommon', keywords: [], collectible: true,
    text: 'Deploy 4.', onPlay: [{ k: 'deploy', n: 4 }],
  },
  {
    id: 80, slug: 'sentinel-array', name: 'Sentinel Array', faction: 'agents', chain: 'base', type: 'unit',
    cost: 5, attack: 4, health: 5, rarity: 'uncommon', keywords: ['guard', 'firewall'], collectible: true,
    text: 'Guard. Firewall: whenever an enemy unit is summoned, deal 1 damage to it.',
  },
  {
    id: 81, slug: 'smart-contract', name: 'Smart Contract', faction: 'agents', chain: 'base', type: 'action',
    cost: 3, rarity: 'rare', keywords: [], collectible: true,
    text: 'Automate: at the start of your next turn, give all friendly units +1/+1, then Deploy 1.',
    onPlay: [{ k: 'automate', effects: [{ k: 'buff', to: 'allFriendly', atk: 1, hp: 1 }, { k: 'deploy', n: 1 }] }],
  },
  {
    id: 82, slug: 'arbitrage-engine', name: 'Arbitrage Engine', faction: 'agents', chain: 'base', type: 'unit',
    cost: 5, attack: 3, health: 5, rarity: 'rare', keywords: [], collectible: true,
    text: 'At the start of your turn, draw 1.', startOfTurn: [{ k: 'draw', n: 1 }],
  },
  {
    id: 83, slug: 'watchdog', name: 'Watchdog', faction: 'agents', chain: 'base', type: 'unit',
    cost: 5, attack: 5, health: 5, rarity: 'rare', keywords: ['guard', 'firewall'], collectible: true,
    text: 'Guard. Firewall: whenever an enemy unit is summoned, deal 1 damage to it.',
  },
  {
    id: 84, slug: 'agent-swarm', name: 'Agent Swarm', faction: 'agents', chain: 'base', type: 'unit',
    cost: 7, attack: 4, health: 4, rarity: 'rare', keywords: [], collectible: true,
    text: 'Deploy 4.', onPlay: [{ k: 'deploy', n: 4 }],
  },
  {
    id: 85, slug: 'the-swarm-mind', name: 'The Swarm Mind', faction: 'agents', chain: 'base', type: 'unit',
    cost: 7, attack: 5, health: 5, rarity: 'legendary', keywords: [], collectible: true,
    text: 'At the start of your turn, Deploy 1, then give all friendly units +1 attack.',
    startOfTurn: [{ k: 'deploy', n: 1 }, { k: 'buff', to: 'allFriendly', atk: 1, hp: 0 }],
  },

  // ─── Tokens (not collectible) ──────────────────────────────────
  {
    id: TOKEN_DRONE, slug: 'drone-token', name: 'Drone', faction: 'agents', chain: 'base', type: 'unit',
    cost: 0, attack: 1, health: 1, rarity: 'common', keywords: [], collectible: false, text: 'Deployed token.',
  },
  {
    id: TOKEN_BOND, slug: 'bond-token', name: 'Bond', faction: 'brokers', chain: 'robinhood', type: 'unit',
    cost: 0, attack: 2, health: 2, rarity: 'common', keywords: [], collectible: false, text: 'Portfolio token.',
  },
  {
    id: TOKEN_TACO, slug: 'taco-token', name: 'Taco', faction: 'neutral', chain: 'base', set: 'poncho', type: 'action',
    cost: 1, rarity: 'common', keywords: [], collectible: false, target: 'friendlyUnit',
    text: 'Give a friendly unit +1/+1.', onPlay: [{ k: 'buff', to: 'chosen', atk: 1, hp: 1 }],
  },
];

const BY_ID = new Map(CARDS.map((c) => [c.id, c]));

export function card(id: number): CardDef {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`unknown card ${id}`);
  return c;
}

export function hasCard(id: number): boolean {
  return BY_ID.has(id);
}

export const COLLECTIBLE = CARDS.filter((c) => c.collectible);
export const RACES: Race[] = ['agents', 'prophets', 'brokers', 'degens'];
export const CARD_SETS: CardSet[] = ['core', 'poncho'];
export const SET_NAME: Record<CardSet, string> = { core: 'Set 1', poncho: 'Poncho' };
export const setOf = (c: CardDef | number): CardSet => (typeof c === 'number' ? card(c) : c).set ?? 'core';

/** Home chain per race. */
export const RACE_CHAIN: Record<Race, 'base' | 'robinhood'> = {
  agents: 'base', prophets: 'base', brokers: 'robinhood', degens: 'robinhood',
};

/** Matchup cycle: key beats value. */
export const BEATS: Record<Race, Race> = {
  prophets: 'agents', agents: 'degens', degens: 'brokers', brokers: 'prophets',
};

export const PREDICTION_TIERS: Record<PredictionCondition, number> = {
  attacks: 1,
  attacks2: 2,
  playsBigUnit: 2,
  plays3Cards: 3,
  summons3: 3,
};

export const PREDICTION_LABELS: Record<PredictionCondition, string> = {
  attacks: 'Opponent attacks next turn',
  attacks2: 'Opponent attacks with 2+ units next turn',
  playsBigUnit: 'Opponent plays a unit costing 4+ next turn',
  plays3Cards: 'Opponent plays 3+ cards next turn',
  summons3: 'Opponent summons 3+ units next turn',
};

// ─── Deck rules ──────────────────────────────────────────────────
export const DECK_SIZE = 30;
export const MAX_COPIES = 2;
export const MAX_LEGENDARY_COPIES = 1;
/** Ranked rarity budget: money buys breadth, not power. */
export const RARITY_POINTS: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2, legendary: 4 };
export const RANKED_RARITY_CAP = 18;
export const MAX_LEGENDARIES_RANKED = 1;

export interface DeckCheck { ok: boolean; errors: string[]; rarityPoints: number }

export function validateDeck(race: Race, deck: number[], ranked = false): DeckCheck {
  const errors: string[] = [];
  if (deck.length !== DECK_SIZE) errors.push(`deck must have ${DECK_SIZE} cards, has ${deck.length}`);
  const counts = new Map<number, number>();
  let rarityPoints = 0;
  let legendaries = 0;
  for (const id of deck) {
    const c = BY_ID.get(id);
    if (!c || !c.collectible) { errors.push(`card ${id} is not collectible`); continue; }
    if (c.faction !== 'neutral' && c.faction !== race) errors.push(`${c.name} is not ${race} or neutral`);
    counts.set(id, (counts.get(id) ?? 0) + 1);
    rarityPoints += RARITY_POINTS[c.rarity];
    if (c.rarity === 'legendary') legendaries++;
  }
  for (const [id, n] of counts) {
    const c = card(id);
    const max = c.rarity === 'legendary' ? MAX_LEGENDARY_COPIES : MAX_COPIES;
    if (n > max) errors.push(`${c.name}: ${n} copies (max ${max})`);
  }
  if (ranked) {
    if (rarityPoints > RANKED_RARITY_CAP) errors.push(`rarity points ${rarityPoints} exceed ranked cap ${RANKED_RARITY_CAP}`);
    if (legendaries > MAX_LEGENDARIES_RANKED) errors.push(`ranked allows ${MAX_LEGENDARIES_RANKED} legendary`);
  }
  return { ok: errors.length === 0, errors, rarityPoints };
}

/**
 * The free starter decks: 2 copies of each of these 15 cards. Pinned, not derived from the card list: Set 1 grows
 * in batches, and a starter deck must not change under players who already claimed it (StarterDecks mints this list).
 * They are the prototype's race cards (no Legendary) plus the core neutrals; collab sets are never in starters.
 */
export const STARTER_CARDS: Readonly<Record<Race, readonly number[]>> = {
  agents: [1, 2, 3, 4, 5, 6, 7, 33, 34, 35, 36, 37, 38, 39, 40],
  prophets: [9, 10, 11, 12, 13, 14, 15, 33, 34, 35, 36, 37, 38, 39, 40],
  brokers: [17, 18, 19, 20, 21, 22, 23, 33, 34, 35, 36, 37, 38, 39, 40],
  degens: [25, 26, 27, 28, 29, 30, 31, 33, 34, 35, 36, 37, 38, 39, 40],
};

/** Free starter deck: 2x each of the race's STARTER_CARDS, sorted. */
export function starterDeck(race: Race): number[] {
  return STARTER_CARDS[race].flatMap((id) => [id, id]);
}

export function factionOf(id: number): Faction { return card(id).faction; }
export const RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'legendary'];
