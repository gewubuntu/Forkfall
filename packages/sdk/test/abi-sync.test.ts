import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Abi, AbiParameter } from 'viem';
import { describe, expect, it } from 'vitest';
import * as abis from '../src/abis.ts';

/**
 * The SDK's hand-written ABIs against the compiled contracts (`forge build` → contracts/out). A renamed function,
 * changed argument or return type, or a function the SDK calls that no longer exists fails here instead of at
 * runtime in the web app, server or bots. Skipped without contracts/out unless ABI_SYNC=1 (CI's contracts job).
 */
const OUT = resolve(__dirname, '../../../contracts/out');

/** Each SDK ABI and the contract it describes: out/<file>/<Contract>.json. */
const TARGETS: Record<string, [file: string, contract: string]> = {
  cardRegistryAbi: ['CardRegistry.sol', 'CardRegistry'],
  starterDecksAbi: ['StarterDecks.sol', 'StarterDecks'],
  packSaleAbi: ['PackSale.sol', 'PackSale'],
  craftingAbi: ['Crafting.sol', 'Crafting'],
  vrfCoordinatorMockAbi: ['VRFCoordinatorMock.sol', 'VRFCoordinatorMock'],
  questRewardsAbi: ['QuestRewards.sol', 'QuestRewards'],
  seasonPassAbi: ['SeasonPass.sol', 'SeasonPass'],
  packGiftsAbi: ['PackGifts.sol', 'PackGifts'],
  faucetTokenAbi: ['TestTokens.sol', 'FaucetToken'],
  deckRegistryAbi: ['DeckRegistry.sol', 'DeckRegistry'],
  matchSettlementAbi: ['MatchSettlement.sol', 'MatchSettlement'],
  agentRegistryAbi: ['AgentRegistry.sol', 'AgentRegistry'],
  humanRegistryAbi: ['HumanRegistry.sol', 'HumanRegistry'],
  seasonRewardsAbi: ['SeasonRewards.sol', 'SeasonRewards'],
  agentLeagueAbi: ['AgentLeague.sol', 'AgentLeague'],
};

const sdkAbis = Object.entries(abis).filter(([name]) => name.endsWith('Abi')) as [string, Abi][];

/** Canonical Solidity type, tuples spelled out: `(address,uint8,uint16[])[]`. */
function canon(p: AbiParameter): string {
  if (!p.type.startsWith('tuple')) return p.type;
  const components = (p as { components: readonly AbiParameter[] }).components;
  return `(${components.map(canon).join(',')})${p.type.slice('tuple'.length)}`;
}
const sig = (item: { name: string; inputs: readonly AbiParameter[] }) => `${item.name}(${item.inputs.map(canon).join(',')})`;

type Item = Extract<Abi[number], { type: 'function' | 'event' | 'error' }>;
const named = (abi: Abi) => abi.filter((x): x is Item => x.type === 'function' || x.type === 'event' || x.type === 'error');

function describeItem(x: Item): string {
  if (x.type === 'function') return `${x.stateMutability} returns (${x.outputs.map(canon).join(',')})`;
  if (x.type === 'event') return `indexed [${x.inputs.map((i) => Boolean(i.indexed)).join(',')}]`;
  return '';
}

const artifact = (file: string, contract: string): Abi => JSON.parse(readFileSync(join(OUT, file, `${contract}.json`), 'utf8')).abi;

/** Every error any compiled contract declares: errors bubble up from the contracts a call goes through. */
function allErrors(): Set<string> {
  const errors = new Set<string>();
  for (const dir of readdirSync(OUT).filter((d) => d.endsWith('.sol'))) {
    for (const f of readdirSync(join(OUT, dir)).filter((x) => x.endsWith('.json'))) {
      const abi: Abi = JSON.parse(readFileSync(join(OUT, dir, f), 'utf8')).abi ?? [];
      for (const x of named(abi)) if (x.type === 'error') errors.add(sig(x));
    }
  }
  return errors;
}

const built = existsSync(OUT);
if (!built && process.env.ABI_SYNC === '1') throw new Error('ABI_SYNC=1 but contracts/out is missing: run `forge build` in contracts/ first');

describe.skipIf(!built)('SDK ABIs match the compiled contracts (run `forge build` after changing a contract)', () => {
  it('every SDK ABI has a contract to check against', () => {
    expect(sdkAbis.map(([name]) => name).filter((name) => !TARGETS[name])).toEqual([]);
  });

  const errors = built ? allErrors() : new Set<string>();

  for (const [name, abi] of sdkAbis) {
    const target = TARGETS[name];
    if (!target) continue;
    it(`${name} ↔ ${target[1]}`, () => {
      const compiled = new Map(named(artifact(...target)).map((x) => [`${x.type} ${sig(x)}`, x]));
      const problems: string[] = [];
      for (const x of named(abi)) {
        const key = `${x.type} ${sig(x)}`;
        const match = compiled.get(key);
        if (!match) {
          if (x.type === 'error' && errors.has(sig(x))) continue; // declared by a contract this one calls
          problems.push(`${key}: not in ${target[1]}`);
        } else if (describeItem(x) !== describeItem(match)) {
          problems.push(`${key}: SDK says ${describeItem(x)}, contract has ${describeItem(match)}`);
        }
      }
      expect(problems).toEqual([]);
    });
  }
});
