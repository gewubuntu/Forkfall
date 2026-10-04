import type { Page } from '@playwright/test';
import type { Hex, LocalAccount } from 'viem';

/**
 * A browser wallet for tests: an EIP-1193 provider announced over EIP-6963, the way MetaMask or Rabby appear,
 * so the app's real connect, sign-in and result-signing code runs. Signing happens in the test process with a
 * viem account (`personal_sign` for the sign-in message, `eth_signTypedData_v4` for match results).
 */
export async function installTestWallet(page: Page, account: LocalAccount, chainId: number) {
  const signed: string[] = [];
  await page.exposeFunction('__ffWalletSign', async (method: string, params: unknown[]): Promise<Hex> => {
    signed.push(method);
    if (method === 'personal_sign') return account.signMessage({ message: { raw: params[0] as Hex } });
    const { domain, types, primaryType, message } = JSON.parse(params[1] as string);
    delete types.EIP712Domain;
    return account.signTypedData({ domain, types, primaryType, message });
  });
  await page.addInitScript(({ address, chainId }) => {
    const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
    const emit = (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((f) => f(...args));
    // Like a real wallet, it remembers that this site was authorized, so a reload reconnects without a prompt.
    const AUTHORIZED = '__ffTestWalletAuthorized';
    let accounts: string[] = localStorage.getItem(AUTHORIZED) ? [address] : [];
    const authorize = (on: boolean) => {
      accounts = on ? [address] : [];
      if (on) localStorage.setItem(AUTHORIZED, '1'); else localStorage.removeItem(AUTHORIZED);
      emit('accountsChanged', accounts);
    };
    const provider = {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        switch (method) {
          case 'eth_chainId': return `0x${chainId.toString(16)}`;
          case 'net_version': return String(chainId);
          case 'eth_requestAccounts':
          case 'wallet_requestPermissions':
            authorize(true);
            return method === 'eth_requestAccounts' ? accounts : [{ parentCapability: 'eth_accounts' }];
          case 'eth_accounts': return accounts;
          case 'wallet_getPermissions': return accounts.length ? [{ parentCapability: 'eth_accounts' }] : [];
          case 'wallet_revokePermissions': authorize(false); return null;
          case 'wallet_switchEthereumChain': return null;
          case 'personal_sign':
          case 'eth_signTypedData_v4':
            return (window as unknown as { __ffWalletSign: (m: string, p: unknown[]) => Promise<string> }).__ffWalletSign(method, params ?? []);
          default:
            throw Object.assign(new Error(`test wallet: ${method} not supported`), { code: 4200 });
        }
      },
      on(event: string, f: (...a: unknown[]) => void) { (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(f); },
      removeListener(event: string, f: (...a: unknown[]) => void) { listeners.get(event)?.delete(f); },
    };
    const info = {
      uuid: '6f1d1b6e-7c1a-4b51-9a4e-0a2f2b7e9c11', name: 'Forkfall Test Wallet', rdns: 'test.forkfall.wallet',
      icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/%3E',
    };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  }, { address: account.address, chainId });
  return { signed };
}
