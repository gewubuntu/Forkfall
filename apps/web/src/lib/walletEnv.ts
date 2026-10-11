/**
 * Where the game is running, as far as wallets go: inside a wallet app's own browser (MetaMask, Coinbase Wallet, …),
 * in a phone browser with no wallet, or on a desktop. Pure functions over the user agent and window.ethereum, so the
 * unit tests can cover them.
 */

export type WalletApp = 'metamask' | 'coinbase' | 'trust' | 'rainbow' | 'rabby' | 'other';

/** The subset of an injected EIP-1193 provider's flags that identifies the wallet. */
export interface InjectedFlags {
  isMetaMask?: boolean; isCoinbaseWallet?: boolean; isCoinbaseBrowser?: boolean; isTrust?: boolean; isTrustWallet?: boolean;
  isRainbow?: boolean; isRabby?: boolean;
}

export const isMobileUA = (ua: string): boolean => /Android|iPhone|iPad|iPod|Mobile/i.test(ua);

/**
 * The wallet whose in-app browser this is, or null in an ordinary browser. The user agent is checked first (wallet
 * browsers tag it); on a phone, any injected provider means a wallet browser too (mobile browsers have no
 * extensions, except Safari/Kiwi edge cases, which then behave like one anyway).
 */
export function walletBrowser(ua: string, eth?: InjectedFlags | null): WalletApp | null {
  if (/MetaMaskMobile|MetaMask\//i.test(ua)) return 'metamask';
  if (/CoinbaseWallet|CoinbaseBrowser|CBWallet/i.test(ua)) return 'coinbase';
  if (/Trust\/|TrustWallet/i.test(ua)) return 'trust';
  if (/Rainbow/i.test(ua)) return 'rainbow';
  if (!eth || !isMobileUA(ua)) return null;
  if (eth.isCoinbaseWallet || eth.isCoinbaseBrowser) return 'coinbase';
  if (eth.isTrust || eth.isTrustWallet) return 'trust';
  if (eth.isRainbow) return 'rainbow';
  if (eth.isRabby) return 'rabby';
  if (eth.isMetaMask) return 'metamask';
  return 'other';
}

export const WALLET_NAMES: Record<WalletApp, string> = {
  metamask: 'MetaMask', coinbase: 'Coinbase Wallet', trust: 'Trust Wallet', rainbow: 'Rainbow', rabby: 'Rabby', other: 'your wallet',
};

/**
 * Links that open this exact page inside a wallet app's browser (installed app, or its store page if missing).
 * Playing there needs no app switching at all: moves and signatures stay in one app.
 */
export function openInWalletLinks(href: string): { app: WalletApp; label: string; url: string }[] {
  const u = new URL(href);
  return [
    { app: 'metamask', label: 'MetaMask', url: `https://metamask.app.link/dapp/${u.host}${u.pathname}${u.search}` },
    { app: 'coinbase', label: 'Coinbase Wallet', url: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(u.href)}` },
  ];
}

export interface WalletEnv { mobile: boolean; inWallet: WalletApp | null }

export function currentWalletEnv(): WalletEnv {
  if (typeof window === 'undefined') return { mobile: false, inWallet: null };
  const ua = navigator.userAgent;
  return { mobile: isMobileUA(ua) || matchMedia?.('(pointer: coarse)').matches === true, inWallet: walletBrowser(ua, (window as { ethereum?: InjectedFlags }).ethereum) };
}
