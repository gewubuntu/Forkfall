import { buildSessionMessage, ForkfallClient, type Me, type ServerConfig } from '@forkfall/sdk';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import { useAccount, useDisconnect, useSignMessage, useSignTypedData, useSwitchChain } from 'wagmi';
import { clearSession, loadSession, saveSession } from '../lib/session.ts';

const SERVER = import.meta.env.VITE_SERVER_URL ?? '';

export type AuthStatus =
  | 'loading'        // reading server config
  | 'offline'        // server unreachable
  | 'disconnected'   // no wallet connected
  | 'wrongChain'     // wallet on a chain other than the hub
  | 'needsSignIn'    // connected, no valid session
  | 'signingIn'      // waiting for the wallet signature / server
  | 'signedIn';

interface AuthState {
  status: AuthStatus;
  config: (ServerConfig & { onchain?: boolean }) | null;
  wallet?: Address;
  me: Me | null;
  client: ForkfallClient | null;
  expiresAt: number | null;
  error: string | null;
  signIn: (hours: number) => Promise<void>;
  signOut: () => Promise<void>;
  disconnect: () => Promise<void>;
  switchToHub: () => Promise<void>;
  clearError: () => void;
}

const Ctx = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

function friendly(e: unknown): string {
  const msg = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  if (/reject|denied|cancel/i.test(msg)) return 'Signature request was cancelled in your wallet.';
  return msg.replace(/^.*?→ \d+: /, '');
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { address, isConnected, chainId } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const { disconnectAsync } = useDisconnect();

  const [config, setConfig] = useState<AuthState['config']>(null);
  const [offline, setOffline] = useState(false);
  const [client, setClient] = useState<ForkfallClient | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The wallet signs match results; keep the latest signer reachable from the client closure.
  const signTypedRef = useRef(signTypedDataAsync);
  signTypedRef.current = signTypedDataAsync;

  useEffect(() => {
    fetch(`${SERVER}/v1/config`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((c) => { setConfig(c); setOffline(false); })
      .catch(() => setOffline(true));
  }, []);

  const hubChainId = config?.chainId;

  const makeClient = useCallback((pk: `0x${string}`, wallet: Address) => new ForkfallClient(SERVER, privateKeyToAccount(pk), {
    wallet,
    signResult: (td) => signTypedRef.current(td as never),
  }), []);

  const reset = useCallback(() => { setClient(null); setMe(null); setExpiresAt(null); }, []);

  // Resume a stored session silently (no wallet popup) whenever the wallet/chain changes.
  useEffect(() => {
    reset();
    if (!address || !hubChainId) return;
    const stored = loadSession(hubChainId, address);
    if (!stored) return;
    let cancelled = false;
    const c = makeClient(stored.pk, address);
    setBusy(true);
    c.connectSession(stored.delegation)
      .then(async (r) => {
        if (cancelled) return;
        setClient(c); setExpiresAt(r.expiresAt); setMe(await c.me());
      })
      .catch(() => { clearSession(hubChainId, address); })
      .finally(() => !cancelled && setBusy(false));
    return () => { cancelled = true; };
  }, [address, hubChainId, makeClient, reset]);

  // Expire the session in the UI exactly when the delegation does.
  useEffect(() => {
    if (!expiresAt) return;
    const t = setTimeout(() => {
      if (address && hubChainId) clearSession(hubChainId, address);
      reset();
      setError('Your session expired. Sign in again to keep playing.');
    }, Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(t);
  }, [expiresAt, address, hubChainId, reset]);

  const signIn = useCallback(async (hours: number) => {
    if (!address || !hubChainId) return;
    setError(null); setBusy(true);
    try {
      const pk = generatePrivateKey();
      const sessionKey = privateKeyToAccount(pk).address;
      const c = makeClient(pk, address);
      const nonce = await c.nonce();
      const expires = new Date(Date.now() + hours * 3600_000);
      const message = buildSessionMessage({
        domain: window.location.host, uri: window.location.origin, wallet: address, sessionKey,
        chainId: hubChainId, nonce, expiresAt: expires,
      });
      const signature = await signMessageAsync({ message });
      const r = await c.connectSession({ message, signature });
      saveSession(address, { pk, delegation: { message, signature }, expiresAt: r.expiresAt, chainId: hubChainId });
      setClient(c); setExpiresAt(r.expiresAt); setMe(await c.me());
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }, [address, hubChainId, makeClient, signMessageAsync]);

  const signOut = useCallback(async () => {
    await client?.logout();
    if (address && hubChainId) clearSession(hubChainId, address);
    reset();
  }, [client, address, hubChainId, reset]);

  const disconnect = useCallback(async () => {
    await signOut();
    await disconnectAsync();
  }, [signOut, disconnectAsync]);

  const switchToHub = useCallback(async () => {
    if (!hubChainId) return;
    setError(null);
    try { await switchChainAsync({ chainId: hubChainId as never }); } catch (e) { setError(friendly(e)); }
  }, [hubChainId, switchChainAsync]);

  const status: AuthStatus = offline ? 'offline'
    : !config ? 'loading'
    : !isConnected || !address ? 'disconnected'
    : client && me ? 'signedIn'
    : busy ? 'signingIn'
    : chainId !== hubChainId ? 'wrongChain'
    : 'needsSignIn';

  const value = useMemo<AuthState>(() => ({
    status, config, wallet: address, me, client, expiresAt, error,
    signIn, signOut, disconnect, switchToHub, clearError: () => setError(null),
  }), [status, config, address, me, client, expiresAt, error, signIn, signOut, disconnect, switchToHub]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
