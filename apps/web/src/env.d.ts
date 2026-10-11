/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** WalletConnect Cloud project id; enables mobile QR and MetaMask mobile. */
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_BASE_SEPOLIA_RPC_URL?: string;
  readonly VITE_ROBINHOOD_TESTNET_RPC_URL?: string;
  /** API origin; empty = same origin (the referee serves the app, or Vite proxies /v1). */
  readonly VITE_SERVER_URL?: string;
}

declare module 'virtual:forkfall-sprites' {
  /** Card sprite atlas built by vite.config.ts (sprite-atlas.ts): cell `index[cardId]`, row-major, `cols` wide. */
  const atlas: { url: string; cols: number; rows: number; cell: number; pad: number; index: Record<number, number> };
  export default atlas;
}
