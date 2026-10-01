import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import {
  base, injectedWallet, metaMaskWallet, rabbyWallet, walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { createConfig, http } from 'wagmi';
import { baseSepolia, foundry } from 'wagmi/chains';
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
/** WalletConnect (mobile QR, MetaMask mobile) needs a WalletConnect Cloud project id. */
export const walletConnectEnabled = projectId.length > 0;

const connectors = connectorsForWallets(
  [
    {
      groupName: 'Recommended',
      wallets: walletConnectEnabled
        ? [base, metaMaskWallet, rabbyWallet, walletConnectWallet]
        : [base, rabbyWallet, injectedWallet],
    },
    ...(walletConnectEnabled ? [{ groupName: 'Other', wallets: [injectedWallet] }] : []),
  ],
  { appName: 'Forkfall', appDescription: 'On-chain card duels for humans and agents (testnet)', projectId: projectId || 'walletconnect-disabled' },
);

export const wagmiConfig = createConfig({
  chains: CHAINS,
  connectors,
  transports: {
    [baseSepolia.id]: http(import.meta.env.VITE_BASE_SEPOLIA_RPC_URL),
    [robinhoodTestnet.id]: http(import.meta.env.VITE_ROBINHOOD_TESTNET_RPC_URL),
    [anvil.id]: http('http://127.0.0.1:8545'),
  },
});

declare module 'wagmi' {
  interface Register { config: typeof wagmiConfig }
}
