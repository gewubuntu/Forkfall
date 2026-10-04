import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { concat, encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  actionHash, agentURIFromFile, agentWalletDomain, AGENT_WALLET_TYPES, buildAgentRegistration, buildSessionMessage,
  canonicalJson, commitSeed, forkfallDomain, humanMethodId, humanMethodName, HUMAN_METHODS, moveDigest, MOVE_TYPES,
  nextHead, parseAgentURI, resultDigest, RESULT_TYPES, sessionKeyFromMessage, ZERO32, type MatchResult,
} from '../src/index.ts';

const contract = (name: string) => readFileSync(resolve(__dirname, `../../../contracts/src/${name}.sol`), 'utf8');

/** EIP-712 encodeType for a struct without nested structs: `Name(type1 name1,type2 name2)`. */
const encodeType = (name: string, fields: readonly { name: string; type: string }[]) =>
  `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;

/** The string a Solidity `keccak256("...")` typehash is built from. */
function solidityTypeString(source: string, constant: string): string {
  const m = new RegExp(`${constant}\\s*=\\s*keccak256\\(\\s*"([^"]+)"`).exec(source);
  if (!m) throw new Error(`${constant} not found`);
  return m[1];
}

/** EIP-712 domain separator computed by hand, the way OpenZeppelin's EIP712 does. */
function domainSeparator(name: string, version: string, chainId: number, verifyingContract: Address): Hex {
  const typeHash = keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [typeHash, keccak256(stringToHex(name)), keccak256(stringToHex(version)), BigInt(chainId), verifyingContract],
  ));
}

const settlement = privateKeyToAccount(generatePrivateKey()).address;
const result: MatchResult = {
  matchId: keccak256(stringToHex('match')), playerA: privateKeyToAccount(generatePrivateKey()).address,
  playerB: privateKeyToAccount(generatePrivateKey()).address, winner: ZERO32.slice(0, 42) as Address,
  deckA: keccak256(stringToHex('a')), deckB: keccak256(stringToHex('b')), mode: 1, season: 7, turns: 9, logHash: keccak256(stringToHex('log')),
};

describe('EIP-712 types match the contracts', () => {
  it('MatchResult: same type string as MatchSettlement.RESULT_TYPEHASH', () => {
    expect(encodeType('MatchResult', RESULT_TYPES.MatchResult)).toBe(solidityTypeString(contract('MatchSettlement'), 'RESULT_TYPEHASH'));
  });

  it('AgentWalletSet: same type string as AgentRegistry.AGENT_WALLET_TYPEHASH', () => {
    expect(encodeType('AgentWalletSet', AGENT_WALLET_TYPES.AgentWalletSet)).toBe(solidityTypeString(contract('AgentRegistry'), 'AGENT_WALLET_TYPEHASH'));
  });

  it('domains use the names and versions the contracts pass to EIP712(...)', () => {
    expect(contract('MatchSettlement')).toContain(`EIP712("${forkfallDomain(1, settlement).name}", "${forkfallDomain(1, settlement).version}")`);
    expect(contract('AgentRegistry')).toContain(`EIP712("${agentWalletDomain(1, settlement).name}", "${agentWalletDomain(1, settlement).version}")`);
  });

  it('resultDigest equals the digest MatchSettlement computes (typehash, abi.encode, 0x1901 prefix)', () => {
    const typeHash = keccak256(stringToHex(solidityTypeString(contract('MatchSettlement'), 'RESULT_TYPEHASH')));
    const structHash = keccak256(encodeAbiParameters(
      ['bytes32', 'bytes32', 'address', 'address', 'address', 'bytes32', 'bytes32', 'uint8', 'uint32', 'uint16', 'bytes32'].map((type) => ({ type })),
      [typeHash, result.matchId, result.playerA, result.playerB, result.winner, result.deckA, result.deckB, result.mode, result.season, result.turns, result.logHash],
    ));
    const expected = keccak256(concat(['0x1901', domainSeparator('Forkfall', '1', 84532, settlement), structHash]));
    expect(resultDigest(forkfallDomain(84532, settlement), result)).toBe(expected);
  });

  it('a result signature is bound to one chain and one deployment', () => {
    const digest = resultDigest(forkfallDomain(84532, settlement), result);
    expect(resultDigest(forkfallDomain(31337, settlement), result)).not.toBe(digest);
    expect(resultDigest(forkfallDomain(84532, privateKeyToAccount(generatePrivateKey()).address), result)).not.toBe(digest);
    expect(resultDigest(forkfallDomain(84532, settlement), { ...result, turns: 10 })).not.toBe(digest);
  });

  it('moveDigest follows the Move type: (matchId, seq, prevHash, actionHash)', () => {
    const m = { matchId: result.matchId, seq: 3, prevHash: keccak256(stringToHex('prev')), actionHash: keccak256(stringToHex('act')) };
    const typeHash = keccak256(stringToHex(encodeType('Move', MOVE_TYPES.Move)));
    expect(encodeType('Move', MOVE_TYPES.Move)).toBe('Move(bytes32 matchId,uint32 seq,bytes32 prevHash,bytes32 actionHash)');
    const structHash = keccak256(encodeAbiParameters(
      ['bytes32', 'bytes32', 'uint32', 'bytes32', 'bytes32'].map((type) => ({ type })), [typeHash, m.matchId, m.seq, m.prevHash, m.actionHash],
    ));
    expect(moveDigest(forkfallDomain(84532, settlement), m)).toBe(keccak256(concat(['0x1901', domainSeparator('Forkfall', '1', 84532, settlement), structHash])));
  });
});

describe('action hashing and the move hash chain', () => {
  it('canonicalJson sorts keys at every level and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it('actionHash does not depend on key order or undefined fields', () => {
    const a = actionHash({ type: 'attack', attacker: 4, target: 'treasury' });
    expect(actionHash({ target: 'treasury', type: 'attack', attacker: 4 } as never)).toBe(a);
    expect(actionHash({ type: 'play', uid: 3, ape: undefined } as never)).toBe(actionHash({ type: 'play', uid: 3 }));
  });

  // Pinned: changing how actions or the chain are hashed breaks every signed log already stored, and the
  // match archives replay these. Change only together with a migration.
  it('hashes stay stable (pinned vectors)', () => {
    expect(actionHash({ type: 'endTurn' })).toBe(keccak256(stringToHex('{"type":"endTurn"}')));
    expect(actionHash({ type: 'endTurn' })).toBe('0xfd56d019b3728fbad2321a46344edb3428b38dceb39ce4ad1be101c7817b489e');
    expect(nextHead(ZERO32, 1, actionHash({ type: 'endTurn' }))).toBe(
      keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint8' }, { type: 'bytes32' }], [ZERO32, 1, actionHash({ type: 'endTurn' })])),
    );
    expect(nextHead(ZERO32, 1, actionHash({ type: 'endTurn' }))).toBe('0xdcab580fe64fc05b3842d95eaf196ce8102e12a1d88a89457b4c48acd8af5abc');
    expect(commitSeed(ZERO32)).toBe(keccak256(ZERO32));
  });

  it('the chain depends on the seat and on every earlier move', () => {
    const a = actionHash({ type: 'endTurn' });
    expect(nextHead(ZERO32, 0, a)).not.toBe(nextHead(ZERO32, 1, a));
    const h1 = nextHead(ZERO32, 0, a);
    expect(nextHead(h1, 1, a)).not.toBe(nextHead(nextHead(ZERO32, 0, actionHash({ type: 'concede' })), 1, a));
  });
});

describe('session keys', () => {
  const wallet = privateKeyToAccount(generatePrivateKey()).address;
  const sessionKey = privateKeyToAccount(generatePrivateKey()).address;
  const build = (key: string = sessionKey) => buildSessionMessage({
    domain: 'forkfall.test', uri: 'https://forkfall.test', wallet, sessionKey: key as Address, chainId: 84532,
    nonce: 'abcdef12345678', expiresAt: new Date(Date.now() + 3600_000),
  });

  it('round-trips the session key through the SIWE message', () => {
    expect(sessionKeyFromMessage(build())).toBe(sessionKey);
    expect(sessionKeyFromMessage(build(sessionKey.toLowerCase()))).toBe(sessionKey); // checksummed on the way out
  });

  it('finds no key in a message without the resource, or with a malformed one', () => {
    expect(sessionKeyFromMessage(build().replace(/urn:forkfall:session-key:/, 'urn:other:'))).toBeNull();
    expect(sessionKeyFromMessage(build().replace(sessionKey, '0x1234'))).toBeNull();
  });
});

describe('agent registration files and human verification methods', () => {
  it('round-trips a registration through a data: agentURI, including non-ASCII names', () => {
    const file = buildAgentRegistration({ name: 'Bot ☕', mcp: 'https://mcp.test', agentId: 5, chainId: 84532, registry: settlement });
    expect(file.registrations).toEqual([{ agentId: 5, agentRegistry: `eip155:84532:${settlement}` }]);
    expect(parseAgentURI(agentURIFromFile(file))).toEqual(file);
  });

  it('parses plain data: JSON and refuses other URIs or bad JSON', () => {
    expect(parseAgentURI(`data:application/json,${encodeURIComponent('{"name":"x"}')}`)).toEqual({ name: 'x' });
    expect(parseAgentURI('ipfs://bafy')).toBeNull();
    expect(parseAgentURI('data:application/json;base64,!!!')).toBeNull();
    expect(parseAgentURI('data:application/json,null')).toBeNull();
  });

  it('maps every human verification method to its keccak id and back', () => {
    for (const m of HUMAN_METHODS) expect(humanMethodName(humanMethodId(m))).toBe(m);
    expect(humanMethodId('coinbase')).toBe(keccak256(stringToHex('coinbase')));
    expect(contract('HumanRegistry')).toContain('keccak256("coinbase")');
    expect(humanMethodName(ZERO32)).toBeNull();
  });
});
