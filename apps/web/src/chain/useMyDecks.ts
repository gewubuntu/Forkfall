import { RACES, type Race } from '@forkfall/engine';
import { deckRegistryAbi } from '@forkfall/sdk';
import type { Address, Hex } from 'viem';
import { useReadContract, useReadContracts } from 'wagmi';
import { useHub } from './useHub.ts';

export interface MyDeck {
  id: Hex;
  race: Race;
  rarityPoints: number;
  legendaries: number;
  cardIds: number[];
  /** Still fully backed by cards the player owns. */
  owned: boolean;
  /** Owned and within the ranked rarity budget. */
  rankedLegal: boolean;
}

/** Decks the player registered in DeckRegistry, newest first, with live validity. */
export function useMyDecks(player: Address | undefined): { decks: MyDeck[]; isLoading: boolean; error: Error | null } {
  const { contracts, chainId } = useHub();
  const cid = chainId as never;
  const ids = useReadContract({
    address: contracts?.DeckRegistry, abi: deckRegistryAbi, functionName: 'decksOf', args: player ? [player] : undefined,
    chainId: cid, query: { enabled: !!contracts && !!player },
  });
  const list = (ids.data ?? []) as readonly Hex[];
  const details = useReadContracts({
    contracts: list.flatMap((id) => [
      { address: contracts!.DeckRegistry, abi: deckRegistryAbi, functionName: 'getDeck', args: [id], chainId: cid } as const,
      { address: contracts!.DeckRegistry, abi: deckRegistryAbi, functionName: 'isValidFor', args: [id, player!, false], chainId: cid } as const,
      { address: contracts!.DeckRegistry, abi: deckRegistryAbi, functionName: 'isValidFor', args: [id, player!, true], chainId: cid } as const,
    ]),
    query: { enabled: list.length > 0 },
  });
  const decks: MyDeck[] = list.map((id, i) => {
    const d = details.data?.[i * 3]?.result as { race: number; rarityPoints: number; legendaries: number; cardIds: readonly number[] } | undefined;
    return {
      id,
      race: RACES[(d?.race ?? 1) - 1],
      rarityPoints: Number(d?.rarityPoints ?? 0),
      legendaries: Number(d?.legendaries ?? 0),
      cardIds: (d?.cardIds ?? []).map(Number),
      owned: !!details.data?.[i * 3 + 1]?.result,
      rankedLegal: !!details.data?.[i * 3 + 2]?.result,
    };
  }).filter((d) => d.cardIds.length > 0).reverse();
  return { decks, isLoading: ids.isLoading || details.isLoading, error: (ids.error ?? details.error) as Error | null };
}
