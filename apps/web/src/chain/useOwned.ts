import { COLLECTIBLE } from '@forkfall/engine';
import { cardRegistryAbi } from '@forkfall/sdk';
import { useMemo } from 'react';
import type { Address } from 'viem';
import { useReadContract } from 'wagmi';
import { useHub } from './useHub.ts';

export interface Owned { tradeable: number; soulbound: number }

const STARTER_OFFSET = 10_000n;
const IDS = COLLECTIBLE.map((c) => BigInt(c.id));

/** Tradeable + soulbound copies of every collectible card, in one balanceOfBatch call. */
export function useOwned(player: Address | undefined) {
  const { contracts, chainId } = useHub();
  const q = useReadContract({
    address: contracts?.CardRegistry, abi: cardRegistryAbi, functionName: 'balanceOfBatch', chainId: chainId as never,
    args: player ? [[...IDS, ...IDS].map(() => player), [...IDS, ...IDS.map((i) => i + STARTER_OFFSET)]] : undefined,
    query: { enabled: !!contracts && !!player },
  });
  const owned = useMemo(() => {
    const m = new Map<number, Owned>();
    const b = q.data;
    COLLECTIBLE.forEach((cd, i) => m.set(cd.id, { tradeable: Number(b?.[i] ?? 0n), soulbound: Number(b?.[i + IDS.length] ?? 0n) }));
    return m;
  }, [q.data]);
  const total = (id: number) => (owned.get(id)?.tradeable ?? 0) + (owned.get(id)?.soulbound ?? 0);
  return { owned, total, isLoading: q.isLoading, error: q.error };
}
