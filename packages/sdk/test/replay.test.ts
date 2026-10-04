import { type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';
import { actionHash, nextHead, replayLog, verifyMoveSignatures, ZERO32, type MatchLog, type MessageVerifier } from '../src/index.ts';
import { clone, signedMatch, type SignedMatch } from './fixtures.ts';

/** Recompute every head from the moves (after editing one), so only the check under test can fail. */
function rechain(log: MatchLog) {
  let head = ZERO32;
  for (const mv of log.moves) mv.head = head = nextHead(head, mv.seat, actionHash(mv.action));
  log.head = log.result.logHash = head;
}

const failing = (log: MatchLog) => Object.entries(replayLog(log).checks).filter(([, c]) => !c.ok).map(([k]) => k);

describe('replayLog', () => {
  let m: SignedMatch;
  beforeAll(async () => { m = await signedMatch(); });

  it('replays an honest log to its signed result, frame by frame', () => {
    const r = replayLog(m.log);
    expect(r.ok).toBe(true);
    expect(failing(m.log)).toEqual([]);
    expect(r.frames).toHaveLength(m.log.moves.length + 1); // the start, then one frame per move
    expect(r.final.status).toBe('ended');
    expect(r.final.turn).toBe(m.log.result.turns);
  });

  it('catches a seed share that does not match its commitment', () => {
    const log = clone(m.log);
    log.players[1].seedShare = generatePrivateKey();
    expect(failing(log)).toContain('seeds');
  });

  it('catches an edited move: the head no longer matches', () => {
    const log = clone(m.log);
    const i = log.moves.findIndex((mv) => mv.action.type === 'endTurn');
    log.moves[i].action = { type: 'concede' };
    expect(replayLog(log).ok).toBe(false);
    expect(replayLog(log).checks.chain.detail).toMatch(new RegExp(`move ${i}: head mismatch`));
  });

  it('catches a log whose moves were all re-hashed but no longer match the signed result', () => {
    const log = clone(m.log);
    log.moves = log.moves.slice(0, -1); // drop the winning move, then fix up the chain itself
    rechain(log);
    log.result.logHash = m.log.result.logHash;
    expect(failing(log)).toEqual(expect.arrayContaining(['chain', 'outcome']));
  });

  it('catches a result claiming the wrong winner or turn count', () => {
    const wrongWinner = clone(m.log);
    wrongWinner.result.winner = wrongWinner.result.winner === wrongWinner.result.playerA ? wrongWinner.result.playerB : wrongWinner.result.playerA;
    expect(failing(wrongWinner)).toEqual(['outcome']);
    expect(replayLog(wrongWinner).ok).toBe(false);
    const wrongTurns = clone(m.log);
    wrongTurns.result.turns += 1;
    expect(failing(wrongTurns)).toEqual(['outcome']);
    expect(replayLog(wrongTurns).ok).toBe(false);
  });

  it('catches an illegal move even when the hash chain is consistent', () => {
    const log = clone(m.log);
    log.moves[0].action = { type: 'attack', attacker: 999, target: 'treasury' };
    rechain(log);
    expect(replayLog(log).checks.chain.detail).toMatch(/move 0: illegal/);
  });

  it('applies a timeout forfeit the referee recorded without a move', async () => {
    const log = clone(m.log);
    // Cut the match before its last move and let the referee's clock end it: the player to move times out.
    log.moves = log.moves.slice(0, 6);
    rechain(log);
    const cut = replayLog({ ...log, endReason: undefined });
    expect(cut.final.status).toBe('active');
    const loser = cut.final.active;
    log.endReason = 'timeout';
    log.result.winner = log.players[loser === 0 ? 1 : 0].address;
    log.result.turns = cut.final.turn;
    const r = replayLog(log);
    expect(r.ok).toBe(true);
    expect(r.final.winner).toBe(loser === 0 ? 1 : 0);
  });
});

describe('verifyMoveSignatures', () => {
  it('verifies every move signed by the players\' wallets', async () => {
    const m = await signedMatch();
    expect(await verifyMoveSignatures(m.log)).toEqual({ verified: m.log.moves.length, forced: 0, unchecked: 0, failed: [] });
  });

  it('verifies moves signed by a session key the wallet delegated to', async () => {
    const m = await signedMatch({ session: true });
    expect(m.signers[0].address).not.toBe(m.wallets[0].address);
    expect(await verifyMoveSignatures(m.log)).toMatchObject({ verified: m.log.moves.length, failed: [] });
  });

  it('fails moves from a session key without a delegation, or one for another wallet', async () => {
    const m = await signedMatch({ session: true });
    const seat0 = m.log.moves.filter((mv) => mv.seat === 0).map((mv) => mv.seq);
    const none = clone(m.log);
    none.players[0].delegations = [];
    expect((await verifyMoveSignatures(none)).failed).toEqual(seat0);

    // A delegation naming another wallet is ignored, so the session key's moves are unauthorized.
    const otherWallet = clone(m.log);
    const d = otherWallet.players[0].delegations[0];
    d.message = d.message.replace(m.wallets[0].address, m.wallets[1].address);
    expect((await verifyMoveSignatures(otherWallet)).failed).toEqual(seat0);
  });

  it('a delegation signature that does not recover to the wallet is unchecked offline, and fails on-chain', async () => {
    // Without a chain client it could be a smart wallet's (ERC-1271) signature, which only a chain call can check.
    const m = await signedMatch({ session: true });
    const forged = clone(m.log);
    const d = forged.players[0].delegations[0];
    d.signature = await privateKeyToAccount(generatePrivateKey()).signMessage({ message: d.message });
    const seat0 = forged.moves.filter((mv) => mv.seat === 0).length;
    expect(await verifyMoveSignatures(forged)).toMatchObject({ unchecked: seat0, failed: [] });
    const chain: MessageVerifier = { verifyMessage: async () => false };
    expect((await verifyMoveSignatures(forged, { client: chain })).failed).toHaveLength(seat0);
  });

  it('fails a move signed for another position in the chain (replayed signature)', async () => {
    const m = await signedMatch();
    const log = clone(m.log);
    const [a, b] = log.moves.filter((mv) => mv.seat === 0);
    [a.signature, b.signature] = [b.signature, a.signature];
    expect((await verifyMoveSignatures(log)).failed).toEqual([a.seq, b.seq].sort((x, y) => x - y));
  });

  it('counts referee-forced moves (timeouts) separately', async () => {
    const m = await signedMatch();
    const log = clone(m.log);
    log.moves[1].signature = null;
    expect(await verifyMoveSignatures(log)).toMatchObject({ forced: 1, verified: log.moves.length - 1, failed: [] });
  });

  it('leaves smart-wallet delegations unchecked without a client, and asks the client when given one', async () => {
    const m = await signedMatch({ session: true });
    // As a smart wallet's: the delegation signature does not recover to the wallet address.
    const log = clone(m.log);
    log.players[0].delegations[0].signature = ('0x' + 'ab'.repeat(65)) as Hex;
    const seat0 = log.moves.filter((mv) => mv.seat === 0).length;
    expect(await verifyMoveSignatures(log)).toMatchObject({ unchecked: seat0, failed: [] });

    const asked: string[] = [];
    const yes: MessageVerifier = { verifyMessage: async (a) => { asked.push(a.address); return true; } };
    expect(await verifyMoveSignatures(log, { client: yes })).toMatchObject({ verified: log.moves.length, unchecked: 0 });
    expect(asked).toEqual([log.players[0].address]);

    const no: MessageVerifier = { verifyMessage: async () => false };
    expect((await verifyMoveSignatures(log, { client: no })).failed).toHaveLength(seat0);
  });
});
