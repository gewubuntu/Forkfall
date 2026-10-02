export type Race = 'agents' | 'prophets' | 'brokers' | 'degens';
export type Faction = Race | 'neutral';
export type Chain = 'base' | 'robinhood';
export type CardType = 'unit' | 'action' | 'prediction' | 'asset';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary';
/** Card set: the core prototype set, or a themed collab set (never in starter decks). */
export type CardSet = 'core' | 'poncho';
export type Keyword = 'guard' | 'rush' | 'hold' | 'swarm' | 'firewall' | 'ape' | 'noBackfire' | 'predictionBonus';
export type TargetKind = 'enemyUnit' | 'friendlyUnit' | 'anyUnit';

/** Who an effect lands on. `chosen` uses the target supplied with the move. */
export type TargetSpec =
  | 'chosen'
  | 'self'
  | 'randomEnemyUnitOrTreasury'
  | 'allFriendly'
  | 'allFriendlySwarm'
  | 'allEnemyUnits'
  | 'allUnits'
  | 'enemyTreasury'
  | 'ownTreasury';

export type Effect =
  | { k: 'damage'; to: TargetSpec; n: number; nIfPrediction?: number }
  | { k: 'draw'; n: number }
  | { k: 'drawIfPrediction'; n: number }
  | { k: 'gainGas'; n: number }
  | { k: 'deploy'; n: number; token?: number }
  | { k: 'buff'; to: TargetSpec; atk: number; hp: number; addKeywords?: Keyword[] }
  | { k: 'pump'; to: TargetSpec }
  | { k: 'rug'; bonus: number }
  | { k: 'compute'; n: number }
  | { k: 'doubleAttack'; to: TargetSpec }
  | { k: 'grantRush'; to: TargetSpec }
  | { k: 'addToHand'; card: number; n: number }
  | { k: 'automate'; effects: Effect[] };

/** Conditions a Prophet can call on the opponent's next turn. Tier drives the Odds payoff. */
export type PredictionCondition = 'attacks' | 'attacks2' | 'playsBigUnit' | 'plays3Cards' | 'summons3';

export interface PredictionPayoff {
  /** Damage to the enemy Treasury per tier when correct. */
  damagePerTier?: number;
  /** Cards drawn per tier when correct. */
  drawPerTier?: number;
  /** Damage taken by your own Treasury when wrong. */
  backfire: number;
}

export interface CardDef {
  id: number;
  slug: string;
  name: string;
  faction: Faction;
  chain: Chain | 'any';
  type: CardType;
  cost: number;
  attack?: number;
  health?: number;
  rarity: Rarity;
  /** Omitted = 'core'. */
  set?: CardSet;
  keywords: Keyword[];
  text: string;
  collectible: boolean;
  target?: TargetKind;
  /** Target is optional: the card may be played without one. */
  targetOptional?: boolean;
  onPlay?: Effect[];
  onDeath?: Effect[];
  startOfTurn?: Effect[];
  /** Brokers: fires when this unit Holds (capped per turn). */
  dividend?: Effect[];
  /** Prophets: fires when one of your predictions comes true while this is on board. */
  onPredictionHit?: Effect[];
  /** Brokers: token card ids that drop to the board when this unit dies. */
  portfolio?: number[];
  prediction?: PredictionPayoff;
}

export interface HandCard { uid: number; cardId: number }

export interface UnitState {
  uid: number;
  cardId: number;
  attack: number;
  health: number;
  maxHealth: number;
  keywords: Keyword[];
  /** Half-turn number on which the unit entered play. */
  summonedTurn: number;
  attacksThisTurn: number;
  /** Did this unit attack during its owner's most recent turn? */
  attackedLastOwnTurn: boolean;
  rushThisTurn: boolean;
}

export interface AssetState { uid: number; cardId: number }

export interface PredictionState {
  uid: number;
  cardId: number;
  condition: PredictionCondition;
  /** Resolves when the opponent ends this half-turn. */
  resolvesOnTurn: number;
}

export interface TurnStats {
  cardsPlayed: number;
  unitsSummoned: number;
  bigUnitsPlayed: number;
  attackers: number[];
}

export interface PlayerState {
  address: string;
  race: Race;
  treasury: number;
  gas: number;
  maxGas: number;
  deck: number[];
  hand: HandCard[];
  board: UnitState[];
  assets: AssetState[];
  predictions: PredictionState[];
  automations: Effect[][];
  graveyard: number[];
  fatigue: number;
  discount: number;
  dividendsThisTurn: number;
  stats: TurnStats;
}

export type Seat = 0 | 1;

export interface GameState {
  version: 1;
  matchId: string;
  seed: string;
  turn: number;
  active: Seat;
  players: [PlayerState, PlayerState];
  rngCounter: number;
  nextUid: number;
  status: 'active' | 'ended';
  winner: Seat | 'draw' | null;
  endReason?: 'treasury' | 'concede' | 'turnLimit' | 'timeout';
}

export type Action =
  | { type: 'play'; uid: number; target?: number | 'enemyTreasury'; condition?: PredictionCondition; ape?: boolean }
  | { type: 'attack'; attacker: number; target: number | 'treasury' }
  | { type: 'endTurn' }
  | { type: 'concede' };

export type GameEvent =
  | { t: 'turnStart'; seat: Seat; turn: number }
  | { t: 'draw'; seat: Seat; uid: number; cardId: number; private: true }
  | { t: 'burn'; seat: Seat; cardId: number }
  | { t: 'create'; seat: Seat; uid: number; cardId: number; private: true }
  | { t: 'fatigue'; seat: Seat; n: number }
  | { t: 'play'; seat: Seat; cardId: number; uid: number; ape?: boolean }
  | { t: 'predictionMade'; seat: Seat; uid: number; cardId: number; condition: PredictionCondition; private: true }
  | { t: 'predictionResolved'; seat: Seat; uid: number; cardId: number; condition: PredictionCondition; hit: boolean }
  | { t: 'summon'; seat: Seat; uid: number; cardId: number }
  | { t: 'attack'; seat: Seat; attacker: number; target: number | 'treasury' }
  | { t: 'damage'; seat: Seat; uid: number | 'treasury'; n: number }
  | { t: 'stat'; seat: Seat; uid: number; attack: number; health: number }
  | { t: 'death'; seat: Seat; uid: number; cardId: number }
  | { t: 'apeDownside'; seat: Seat; kind: 'treasury' | 'discard' | 'fragile' }
  | { t: 'hold'; seat: Seat; uid: number }
  | { t: 'automate'; seat: Seat }
  | { t: 'gameOver'; winner: Seat | 'draw'; reason: string };

export interface PlayerConfig {
  address: string;
  race: Race;
  deck: number[];
  /** Private per-player salt; mixes into the deck shuffle so only this player and the referee know the order. */
  deckSalt: string;
}

export interface MatchConfig {
  matchId: string;
  /** Combined seed from both players' commit-reveal. */
  seed: string;
  players: [PlayerConfig, PlayerConfig];
}
