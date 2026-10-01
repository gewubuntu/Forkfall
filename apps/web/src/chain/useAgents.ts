import { agentRegistryAbi, parseAgentURI, type AgentRegistrationFile } from '@forkfall/sdk';
import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { usePublicClient } from 'wagmi';
import { useHub } from './useHub.ts';

export interface AgentInfo {
  id: number;
  owner: Address;
  /** The wallet the agent plays from (zero address = none linked). */
  wallet: Address;
  uri: string;
  /** Decoded registration file for data: URIs (null for ipfs:// / https:// ones). */
  file: AgentRegistrationFile | null;
  name: string;
}

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * ERC-8004 agents around this wallet: the agents it owns (operator view), the agent it plays as (if any),
 * the operator cap and the next agent id (for registering with a pre-signed wallet proof).
 */
export function useAgents(me: Address | undefined) {
  const { chainId, contracts } = useHub();
  const client = usePublicClient({ chainId: chainId as never });
  const registry = contracts?.AgentRegistry;
  return useQuery({
    queryKey: ['agents', registry, me],
    enabled: !!client && !!registry && !!me,
    queryFn: async () => {
      const read = <T,>(functionName: string, args: unknown[] = []) =>
        client!.readContract({ address: registry!, abi: agentRegistryAbi, functionName, args } as never) as Promise<T>;
      const load = async (id: number): Promise<AgentInfo> => {
        const [owner, wallet, uri] = await Promise.all([
          read<Address>('ownerOf', [BigInt(id)]),
          read<Address>('getAgentWallet', [BigInt(id)]),
          read<string>('tokenURI', [BigInt(id)]).catch(() => ''),
        ]);
        const file = parseAgentURI(uri);
        return { id, owner, wallet, uri, file, name: file?.name || `Agent #${id}` };
      };
      const [count, cap, next, playsAs] = await Promise.all([
        read<bigint>('balanceOf', [me]), read<bigint>('maxAgentsPerOperator'), read<bigint>('nextAgentId'), read<bigint>('agentOf', [me]),
      ]);
      const ids = await Promise.all(Array.from({ length: Number(count) }, (_, i) => read<bigint>('tokenOfOwnerByIndex', [me, BigInt(i)])));
      const owned = await Promise.all(ids.map((id) => load(Number(id))));
      return {
        owned: owned.sort((a, b) => a.id - b.id),
        playsAs: playsAs > 0n ? await load(Number(playsAs)) : null,
        cap: Number(cap),
        nextId: Number(next),
        registry: registry!,
      };
    },
  });
}

export const hasWallet = (a: AgentInfo) => a.wallet !== ZERO;
