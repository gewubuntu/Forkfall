import {
  applyAction, combineSeeds, createMatch, forfeit,
  type Action, type GameEvent, type GameState, type Race, type Seat,
} from '@forkfall/engine';
import { parseSiweMessage } from 'viem/siwe';
import { recoverAddress, recoverMessageAddress, type Address, type Hex, type TypedDataDomain } from 'viem';
import {
  actionHash, commitSeed, moveDigest, nextHead, sessionKeyFromMessage, ZERO32, ZERO_ADDRESS,
  type Delegation, type MatchResult, type Mode,
} from './protocol.ts';

/** Public, signed record of a finished match (`GET /v1/matches/:id/log`). */
export interface MatchLog {
  matchId: Hex;
  mode: Mode;
  season?: number;
  createdAt?: number;
  endedAt?: number;
  endReason?: GameState['endReason'];
  domain: TypedDataDomain;
  players: {
    address: Address; race: Race; deck: number[]; deckId: Hex; agent: boolean;
    seedCommit: Hex; seedShare: Hex; deckSalt: Hex; delegations: Delegation[];
  }[];
  /** signature null = forced by the referee (turn timer ran out). */
  moves: { seq: number; seat: Seat; action: Action; signature: Hex | null; head: Hex }[];
  head: Hex;
  result: MatchResult;
}

export interface ReplayFrame {
  /** Move that led to this frame (null = opening deal). */
  move: MatchLog['moves'][number] | null;
  state: GameState;
  events: GameEvent[];
}

export interface ReplayCheck { ok: boolean; label: string; detail?: string }

export interface Replay {
  frames: ReplayFrame[];
  final: GameState;
  checks: { seeds: ReplayCheck; chain: ReplayCheck; outcome: ReplayCheck };
  ok: boolean;
}

/**
 * Re-runs a match from its public log with the shared rules engine: the same seed reveals, decks and
 * moves must reproduce the hash-chain head and the result that was signed. Anyone can do this.
 */
export function replayLog(log: MatchLog): Replay {
  const [a, b] = log.players;
  const seedsOk = commitSeed(a.seedShare) === a.seedCommit && commitSeed(b.seedShare) === b.seedCommit;
  const r0 = createMatch({
    matchId: log.matchId,
    seed: combineSeeds(log.matchId, a.seedShare, b.seedShare),
    players: [
      { address: a.address, race: a.race, deck: a.deck, deckSalt: a.deckSalt },
      { address: b.address, race: b.race, deck: b.deck, deckSalt: b.deckSalt },
    ],
  });
  const frames: ReplayFrame[] = [{ move: null, state: r0.state, events: r0.events }];
  let state = r0.state;
  let head: Hex = ZERO32;
  let chainErr: string | undefined;
  for (const mv of log.moves) {
    head = nextHead(head, mv.seat, actionHash(mv.action));
    if (head !== mv.head && !chainErr) chainErr = `move ${mv.seq}: head mismatch`;
    let r;
    try { r = applyAction(state, mv.seat, mv.action); } catch (e) {
      chainErr ??= `move ${mv.seq}: illegal (${(e as Error).message})`;
      break;
    }
    state = r.state;
    frames.push({ move: mv, state, events: r.events });
  }
  // Timeout forfeits are decided by the referee clock, not by a move.
  if (state.status === 'active' && log.endReason === 'timeout') {
    const loserAddr = log.result.winner === a.address ? b.address : a.address;
    const r = forfeit(state, loserAddr === a.address ? 0 : 1);
    state = r.state;
    frames.push({ move: null, state, events: r.events });
  }
  if (!chainErr && head !== log.head) chainErr = 'final head differs from the log head';
  if (!chainErr && head !== log.result.logHash) chainErr = 'final head differs from the signed result';

  const winner = state.winner === 'draw' || state.winner === null ? ZERO_ADDRESS : log.players[state.winner].address;
  const outcomeOk = state.status === 'ended'
    && log.result.matchId === log.matchId
    && winner.toLowerCase() === log.result.winner.toLowerCase()
    && state.turn === Number(log.result.turns);
  const checks = {
    seeds: { ok: seedsOk, label: 'Seed reveals match both commitments' },
    chain: { ok: !chainErr, label: `Hash chain over ${log.moves.length} moves matches the signed log hash`, detail: chainErr },
    outcome: {
      ok: outcomeOk,
      label: 'Replayed match id, winner and turn count match the signed result',
      detail: outcomeOk ? undefined : `replay: ${state.status === 'ended' ? `winner ${winner}, turn ${state.turn}` : 'match did not end'}`,
    },
  };
  return { frames, final: state, checks, ok: seedsOk && !chainErr && outcomeOk };
}

export interface SignatureReport {
  /** Moves signed by the player's wallet or an authorized session key. */
  verified: number;
  /** Referee-forced turn ends (timeouts), unsigned by design. */
  forced: number;
  /** Signed by a smart wallet's session key whose delegation needs an RPC (ERC-1271) to check. */
  unchecked: number;
  failed: number[];
}

/**
 * Checks every move signature in a log. EOAs and session keys are checked by recovery; a session
 * key counts only if the player's wallet signed its delegation (EOA wallets; smart wallets are
 * reported as unchecked because ERC-1271 needs a chain call).
 */
export async function verifyMoveSignatures(log: MatchLog): Promise<SignatureReport> {
  const rep: SignatureReport = { verified: 0, forced: 0, unchecked: 0, failed: [] };
  const keys = await Promise.all(log.players.map(async (p) => {
    const out = new Map<string, boolean>(); // session key → delegation proven by recovery
    for (const d of p.delegations ?? []) {
      const key = sessionKeyFromMessage(d.message);
      const parsed = parseSiweMessage(d.message);
      if (!key || parsed.address?.toLowerCase() !== p.address.toLowerCase()) continue;
      const signer = await recoverMessageAddress({ message: d.message, signature: d.signature }).catch(() => null);
      out.set(key.toLowerCase(), signer?.toLowerCase() === p.address.toLowerCase());
    }
    return out;
  }));
  let prev: Hex = ZERO32;
  for (const mv of log.moves) {
    if (!mv.signature) { rep.forced++; prev = mv.head; continue; }
    const digest = moveDigest(log.domain, { matchId: log.matchId, seq: mv.seq, prevHash: prev, actionHash: actionHash(mv.action) });
    prev = mv.head;
    const signer = (await recoverAddress({ hash: digest, signature: mv.signature }).catch(() => null))?.toLowerCase();
    const player = log.players[mv.seat].address.toLowerCase();
    if (signer === player) { rep.verified++; continue; }
    const delegated = signer ? keys[mv.seat].get(signer) : undefined;
    if (delegated === true) rep.verified++;
    else if (delegated === false) rep.unchecked++;
    else rep.failed.push(mv.seq);
  }
  return rep;
}
