import type { GameEvent, GameState, HandCard, PredictionState, Seat, UnitState, AssetState, Race } from './types.ts';

export interface PublicPlayer {
  address: string;
  race: Race;
  treasury: number;
  gas: number;
  maxGas: number;
  deckCount: number;
  handCount: number;
  board: UnitState[];
  assets: AssetState[];
  /** Opponent predictions are face-down: only uid and resolve turn are visible. */
  predictions: (PredictionState | { uid: number; resolvesOnTurn: number; hidden: true })[];
  automationsQueued: number;
  graveyard: number[];
  discount: number;
}

export interface PlayerView {
  matchId: string;
  turn: number;
  active: Seat;
  you: Seat | null;
  status: GameState['status'];
  winner: GameState['winner'];
  endReason?: GameState['endReason'];
  hand: HandCard[];
  players: [PublicPlayer, PublicPlayer];
}

/**
 * Redacted view: a player sees their own hand and predictions and nothing else hidden.
 * Spectators (seat = null) see neither hand. Agents and humans get the exact same view.
 */
export function viewFor(g: GameState, seat: Seat | null): PlayerView {
  const pub = (i: Seat): PublicPlayer => {
    const p = g.players[i];
    const mine = seat === i || g.status === 'ended';
    return {
      address: p.address,
      race: p.race,
      treasury: p.treasury,
      gas: p.gas,
      maxGas: p.maxGas,
      deckCount: p.deck.length,
      handCount: p.hand.length,
      board: p.board,
      assets: p.assets,
      predictions: p.predictions.map((x) => (mine ? x : { uid: x.uid, resolvesOnTurn: x.resolvesOnTurn, hidden: true as const })),
      automationsQueued: p.automations.length,
      graveyard: p.graveyard,
      discount: p.discount,
    };
  };
  return {
    matchId: g.matchId,
    turn: g.turn,
    active: g.active,
    you: seat,
    status: g.status,
    winner: g.winner,
    endReason: g.endReason,
    hand: seat === null ? [] : g.players[seat].hand,
    players: [pub(0), pub(1)],
  };
}

/** Drop events the viewer must not see (opponent draws, face-down predictions). */
export function eventsFor(events: GameEvent[], seat: Seat | null): GameEvent[] {
  return events.filter((e) => !('private' in e) || e.seat === seat);
}
