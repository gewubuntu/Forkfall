import { describe, expect, it } from 'vitest';
import { isMobileUA, openInWalletLinks, walletBrowser } from '../src/lib/walletEnv.ts';

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PIXEL_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const DESKTOP_CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

describe('wallet in-app browser detection', () => {
  it('reads the wallet from its user agent tag', () => {
    expect(walletBrowser(`${PIXEL_CHROME} MetaMaskMobile`, { isMetaMask: true })).toBe('metamask');
    expect(walletBrowser(`${IPHONE_SAFARI} MetaMask/7.30.0`, null)).toBe('metamask');
    expect(walletBrowser(`${IPHONE_SAFARI} CoinbaseWallet/28.0`, null)).toBe('coinbase');
    expect(walletBrowser(`${PIXEL_CHROME} Trust/10.2`, null)).toBe('trust');
  });
  it('falls back to the injected provider on phones only', () => {
    expect(walletBrowser(IPHONE_SAFARI, { isCoinbaseWallet: true })).toBe('coinbase');
    expect(walletBrowser(PIXEL_CHROME, { isMetaMask: true })).toBe('metamask');
    // Coinbase Wallet also sets isMetaMask for compatibility: its own flag wins.
    expect(walletBrowser(PIXEL_CHROME, { isMetaMask: true, isCoinbaseWallet: true })).toBe('coinbase');
    expect(walletBrowser(PIXEL_CHROME, {})).toBe('other');
    // A desktop browser with the MetaMask extension is not a wallet browser.
    expect(walletBrowser(DESKTOP_CHROME, { isMetaMask: true })).toBeNull();
    expect(walletBrowser(IPHONE_SAFARI, null)).toBeNull();
  });
  it('tells phones from desktops', () => {
    expect(isMobileUA(IPHONE_SAFARI)).toBe(true);
    expect(isMobileUA(PIXEL_CHROME)).toBe(true);
    expect(isMobileUA(DESKTOP_CHROME)).toBe(false);
  });
});

describe('open in wallet app', () => {
  it('deep-links the current page, path and query included', () => {
    const [mm, cb] = openInWalletLinks('https://forkfall.example/challenge/AB12?ref=0xabc');
    expect(mm.url).toBe('https://metamask.app.link/dapp/forkfall.example/challenge/AB12?ref=0xabc');
    expect(cb.url).toBe('https://go.cb-w.com/dapp?cb_url=https%3A%2F%2Fforkfall.example%2Fchallenge%2FAB12%3Fref%3D0xabc');
  });
});
