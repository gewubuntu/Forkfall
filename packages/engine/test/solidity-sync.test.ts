import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { renderSolidity } from '../scripts/gen-solidity.ts';

it('contracts/src/generated/Set1Cards.sol matches the engine card list (run `pnpm gen:cards`)', () => {
  const onDisk = readFileSync(resolve(__dirname, '../../../contracts/src/generated/Set1Cards.sol'), 'utf8');
  expect(onDisk).toBe(renderSolidity());
});
