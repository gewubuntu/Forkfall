import { applyAction, combineSeeds, createMatch, greedyBot, keccakHex, starterDeck, type PlayerConfig, type Race, type Seat } from '@forkfall/engine';
import type { Hex, LocalAccount } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  actionHash, buildSessionMessage, commitSeed, forkfallDomain, MOVE_TYPES, nextHead, ZERO32,
  type Delegation, type MatchLog,
} from '../src/index.ts';

export interface SignedMatch {
  log: MatchLog;
  wallets: [LocalAccount, LocalAccount];
  /** The key that signed each seat's moves: the wallet itself, or a session key it delegated to. */
  signers: [LocalAccount, LocalAccount];
}

/**
 * A full match between two greedy bots, every move signed the way the referee stores it: a hash chain over
 * (seat, actionHash) and an EIP-712 Move signature per move. Seat 0 can sign through a SIWE-delegated session
 * key instead of its wallet (`session: true`). `rules` plays it under an older card rules version; the log records the
 * version unless `unrecorded` (a log from before versions were recorded). `seed` makes every key and share
 * deterministic, so the same match is played every run.
 */
export async function signedMatch(opts: { races?: [Race, Race]; session?: boolean; rules?: number; unrecorded?: boolean; seed?: string; createdAt?: number } = {}): Promise<SignedMatch> {
  let n = 0;
  const hex32 = () => (opts.seed ? keccakHex(opts.seed, String(n++)) : generatePrivateKey()) as Hex;
  const races = opts.races ?? ['brokers', 'degens'];
  const wallets: [LocalAccount, LocalAccount] = [privateKeyToAccount(hex32()), privateKeyToAccount(hex32())];
  const domain = forkfallDomain(84532, privateKeyToAccount(hex32()).address);
  const matchId = hex32();
  const shares = [hex32(), hex32()] as const;
  const salts = [hex32(), hex32()] as const;
  const decks = races.map((r) => starterDeck(r));

  const delegations: [Delegation[], Delegation[]] = [[], []];
  const signers: [LocalAccount, LocalAccount] = [...wallets];
  if (opts.session) {
    const key = privateKeyToAccount(hex32());
    const message = buildSessionMessage({
      domain: 'forkfall.test', uri: 'https://forkfall.test', wallet: wallets[0].address, sessionKey: key.address,
      chainId: 84532, nonce: 'abcdef12345678', expiresAt: new Date(Date.now() + 3600_000),
    });
    delegations[0].push({ message, signature: await wallets[0].signMessage({ message }) });
    signers[0] = key;
  }

  let state = createMatch({
    matchId, seed: combineSeeds(matchId, shares[0], shares[1]),
    players: [0, 1].map((i): PlayerConfig => ({ address: wallets[i].address, race: races[i], deck: decks[i], deckSalt: salts[i] })) as [PlayerConfig, PlayerConfig],
    rules: opts.rules,
  }).state;
  const bot = greedyBot();
  const moves: MatchLog['moves'] = [];
  let head = ZERO32;
  while (state.status === 'active' && moves.length < 2000) {
    const seat = state.active as Seat;
    const action = bot(state, seat);
    const aHash = actionHash(action);
    const signature = await signers[seat].signTypedData({
      domain, types: MOVE_TYPES, primaryType: 'Move', message: { matchId, seq: moves.length, prevHash: head, actionHash: aHash },
    });
    head = nextHead(head, seat, aHash);
    moves.push({ seq: moves.length, seat, action, signature, head });
    state = applyAction(state, seat, action).state;
  }
  const winner = state.winner === 0 || state.winner === 1 ? wallets[state.winner].address : ('0x' + '0'.repeat(40)) as Hex;
  const log: MatchLog = {
    matchId, mode: 'casual', season: 1, createdAt: opts.createdAt ?? 1, endedAt: 2, endReason: state.endReason,
    ...(opts.unrecorded ? {} : { rules: state.rules }),
    domain: { ...domain, chainId: 84532 },
    players: [0, 1].map((i) => ({
      address: wallets[i].address, race: races[i], deck: decks[i], deckId: ZERO32, agent: false,
      seedCommit: commitSeed(shares[i]), seedShare: shares[i], deckSalt: salts[i], delegations: delegations[i],
    })),
    moves, head,
    result: {
      matchId, playerA: wallets[0].address, playerB: wallets[1].address, winner, deckA: ZERO32, deckB: ZERO32,
      mode: 0, season: 1, turns: state.turn, logHash: head,
    },
  };
  return { log, wallets, signers };
}

/** A deep copy, for tampering with one field. */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
