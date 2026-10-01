import { createConfig, http, injected } from 'wagmi';
import { baseSepolia, foundry } from 'wagmi/chains';
import { baseAccount, metaMask, walletConnect } from 'wagmi/connectors';
import { defineChain } from 'viem';

/** Testnets only. Mainnet chains are deliberately absent from this config. */
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com/rpc'] } },
  blockExplorers: { default: { name: 'Explorer', url: 'https://explorer.testnet.chain.robinhood.com' } },
  testnet: true,
});

export const anvil = { ...foundry, name: 'Local Anvil' } as const;
export const CHAINS = [baseSepolia, robinhoodTestnet, anvil] as const;
export const CHAIN_NAMES: Record<number, string> = Object.fromEntries(CHAINS.map((c) => [c.id, c.name]));

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '';
/** WalletConnect (phone wallets via QR) needs a WalletConnect Cloud / Reown project id. */
export const walletConnectEnabled = projectId.length > 0;

const appUrl = typeof window === 'undefined' ? 'https://forkfall.example' : window.location.origin;

export const wagmiConfig = createConfig({
  chains: CHAINS,
  // EIP-6963: installed browser wallets (MetaMask, Rabby, …) announce themselves and appear automatically.
  multiInjectedProviderDiscovery: true,
  connectors: [
    baseAccount({ appName: 'Forkfall' }),
    metaMask({ dapp: { name: 'Forkfall', url: appUrl } }),
    ...(walletConnectEnabled
      ? [walletConnect({ projectId, showQrModal: true, metadata: { name: 'Forkfall', description: 'On-chain card duels (testnet)', url: appUrl, icons: [] } })]
      : []),
    // Fallback for wallets that only expose window.ethereum without EIP-6963.
    injected({ shimDisconnect: true }),
  ],
  transports: {
    [baseSepolia.id]: http(import.meta.env.VITE_BASE_SEPOLIA_RPC_URL),
    [robinhoodTestnet.id]: http(import.meta.env.VITE_ROBINHOOD_TESTNET_RPC_URL),
    [anvil.id]: http('http://127.0.0.1:8545'),
  },
});

declare module 'wagmi' {
  interface Register { config: typeof wagmiConfig }
}
