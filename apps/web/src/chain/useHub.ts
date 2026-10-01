import type { HubContracts } from '@forkfall/sdk';
import { useAuth } from '../auth/AuthProvider.tsx';

/** Hub chain + deployed contract addresses, as served by the referee. */
export function useHub(): { chainId: number; contracts: HubContracts | null; explorer: string | null } {
  const { config } = useAuth();
  return { chainId: config?.chainId ?? 0, contracts: config?.contracts ?? null, explorer: config?.explorer ?? null };
}
