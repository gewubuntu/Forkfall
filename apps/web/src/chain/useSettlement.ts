import { matchSettlementAbi } from '@forkfall/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { Address, Hex } from 'viem';
import { useReadContracts } from 'wagmi';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useTx } from './Tx.tsx';
import { useHub } from './useHub.ts';

/** Which of these matches already settled on MatchSettlement. */
export function useSettled(matchIds: Hex[]): { settled: Map<Hex, boolean>; isLoading: boolean } {
  const { chainId, contracts } = useHub();
  const q = useReadContracts({
    contracts: matchIds.map((id) => ({
      address: contracts?.MatchSettlement, abi: matchSettlementAbi, functionName: 'settled', args: [id], chainId: chainId as never,
    } as const)),
    query: { enabled: !!contracts && matchIds.length > 0 },
  });
  const settled = new Map<Hex, boolean>();
  matchIds.forEach((id, i) => { const r = q.data?.[i]?.result; if (r !== undefined) settled.set(id, r as boolean); });
  return { settled, isLoading: q.isLoading };
}

export interface SeasonStats { wins: number; losses: number; draws: number; rating: number }

/** On-chain record for each address in `season` (0 = casual). Unrated players read as 1200. */
export function useSeasonStats(addresses: Address[], season: number): { stats: Map<string, SeasonStats>; isLoading: boolean } {
  const { chainId, contracts } = useHub();
  const q = useReadContracts({
    contracts: addresses.map((a) => ({
      address: contracts?.MatchSettlement, abi: matchSettlementAbi, functionName: 'stats', args: [season, a], chainId: chainId as never,
    } as const)),
    query: { enabled: !!contracts && addresses.length > 0 },
  });
  const stats = new Map<string, SeasonStats>();
  addresses.forEach((a, i) => {
    const r = q.data?.[i]?.result as SeasonStats | undefined;
    if (r) stats.set(a.toLowerCase(), { wins: Number(r.wins), losses: Number(r.losses), draws: Number(r.draws), rating: Number(r.rating) });
  });
  return { stats, isLoading: q.isLoading };
}

/**
 * Submit a fully signed result to MatchSettlement from the connected wallet. Anyone may submit;
 * the contract checks both players' signatures (and the referee's for rated modes).
 */
export function useSettleMatch() {
  const { client } = useAuth();
  const { contracts } = useHub();
  const tx = useTx();
  const qc = useQueryClient();
  return useCallback(async (matchId: Hex): Promise<boolean> => {
    if (!client || !contracts) throw new Error('Not connected to the hub contracts.');
    const s = await client.settlement(matchId);
    if (s.byReferee) throw new Error('Only the referee can settle this one (your opponent never signed).');
    const r = s.result;
    const rc = await tx.run('Settle match', {
      address: contracts.MatchSettlement,
      abi: matchSettlementAbi,
      functionName: 'settle',
      args: [{ ...r, mode: Number(r.mode), season: Number(r.season), turns: Number(r.turns) }, s.sigA!, s.sigB!, s.refereeSig ?? '0x'],
    });
    if (rc) await qc.invalidateQueries();
    return !!rc;
  }, [client, contracts, tx, qc]);
}
