import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConnect, useConnection, useConnectors, type Connector } from 'wagmi';
import { currentWalletEnv, openInWalletLinks, WALLET_NAMES } from '../lib/walletEnv.ts';
import { walletConnectEnabled } from '../wagmi.ts';

interface ConnectModalApi { open: () => void; close: () => void }
const Ctx = createContext<ConnectModalApi | null>(null);

export function useConnectModal(): ConnectModalApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useConnectModal outside ConnectModalProvider');
  return v;
}

export function ConnectModalProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const api = useMemo(() => ({ open: () => setOpen(true), close: () => setOpen(false) }), []);
  return <Ctx.Provider value={api}>{children}{open && <ConnectModal onClose={api.close} />}</Ctx.Provider>;
}

type Entry = { connector: Connector; label: string; hint: string; icon?: string };

/** Order and label the configured connectors; hide duplicates of wallets the browser already announced. */
function useWalletEntries(): { installed: Entry[]; other: Entry[] } {
  const connectors = useConnectors();
  return useMemo(() => {
    const announced = connectors.filter((c) => c.type === 'injected' && c.id !== 'injected');
    const hasMetaMaskExt = announced.some((c) => c.id === 'io.metamask' || /metamask/i.test(c.name));
    const installed: Entry[] = announced.map((c) => ({ connector: c, label: c.name, hint: 'Installed', icon: c.icon }));
    const generic = connectors.find((c) => c.id === 'injected');
    if (!announced.length && generic && typeof window !== 'undefined' && (window as { ethereum?: unknown }).ethereum) {
      installed.push({ connector: generic, label: 'Browser wallet', hint: 'Installed' });
    }
    const other: Entry[] = [];
    for (const c of connectors) {
      if (c.type === 'baseAccount') other.push({ connector: c, label: 'Base Account', hint: 'Passkey smart wallet, no extension needed', icon: c.icon });
      else if (c.type === 'metaMask' && !hasMetaMaskExt) other.push({ connector: c, label: 'MetaMask', hint: 'Mobile app or extension', icon: c.icon });
      else if (c.type === 'walletConnect') other.push({ connector: c, label: 'WalletConnect', hint: 'Scan with a phone wallet', icon: c.icon });
    }
    return { installed, other };
  }, [connectors]);
}

function ConnectModal({ onClose }: { onClose: () => void }) {
  const { installed, other } = useWalletEntries();
  const connect = useConnect();
  const { isConnected } = useConnection();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const env = useMemo(() => currentWalletEnv(), []);
  // Inside a wallet's own browser the injected wallet is the one to use; elsewhere on a phone, opening the game in
  // the wallet app avoids switching apps for every signature.
  const inWallet = env.inWallet && installed.length > 0;
  const offerOpenIn = env.mobile && !env.inWallet && installed.length === 0;

  useEffect(() => { if (isConnected) onClose(); }, [isConnected, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.querySelector<HTMLButtonElement>('button.wallet')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pick = useCallback(async (e: Entry) => {
    setError(null); setPending(e.connector.uid);
    try {
      await connect.mutateAsync({ connector: e.connector });
    } catch (err) {
      const msg = (err as { shortMessage?: string; message?: string }).shortMessage ?? (err as Error).message;
      setError(/reject|denied|cancel/i.test(msg) ? 'Connection request was cancelled.' : msg);
    } finally {
      setPending(null);
    }
  }, [connect]);

  const row = (e: Entry) => (
    <button key={e.connector.uid} className="wallet" disabled={!!pending} onClick={() => pick(e)}>
      {e.icon ? <img src={e.icon} alt="" /> : <span className="wallet-glyph" aria-hidden>{e.label[0]}</span>}
      <span className="wallet-text"><b>{e.label}</b><small>{e.hint}</small></span>
      {pending === e.connector.uid && <span className="spinner" aria-label="Connecting" />}
    </button>
  );

  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="connect-title" ref={dialogRef}>
        <div className="modal-head">
          <h2 id="connect-title">Connect a wallet</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {error && <div className="alert err" role="alert"><span>{error}</span></div>}
        {inWallet ? (
          <>
            <p className="modal-note in-wallet">You’re in the {WALLET_NAMES[env.inWallet!]} browser: connect it here, and signatures pop up right in this app.</p>
            {installed.map(row)}
            {!more
              ? <button className="btn btn-ghost btn-block" onClick={() => setMore(true)}>Other ways to connect</button>
              : <><div className="wallet-group">Other options</div>{other.map(row)}</>}
          </>
        ) : (
          <>
            {offerOpenIn && (
              <>
                <div className="wallet-group">Play inside your wallet app</div>
                <p className="modal-note open-in-note">Recommended on phones: the game opens in the wallet’s browser, so signing never switches apps.</p>
                {openInWalletLinks(window.location.href).map((l) => (
                  <a key={l.app} className="wallet" href={l.url} rel="noopener">
                    <span className={`wallet-glyph wg-${l.app}`} aria-hidden>{l.label[0]}</span>
                    <span className="wallet-text"><b>Open in {l.label}</b><small>Opens this page in the {l.label} app</small></span>
                    <span aria-hidden>↗</span>
                  </a>
                ))}
              </>
            )}
            {installed.length > 0 && <><div className="wallet-group">Installed</div>{installed.map(row)}</>}
            <div className="wallet-group">{installed.length ? 'Other options' : offerOpenIn ? 'Or connect from this browser' : 'Choose a wallet'}</div>
            {other.map(row)}
          </>
        )}
        {!walletConnectEnabled && <p className="modal-note">Phone wallets via WalletConnect are off until a project id is configured.</p>}
        <p className="modal-note">Testnet alpha: use a wallet with no real funds. Cards and tokens have no value.</p>
      </div>
    </div>
  );
}
