import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.tsx';
import { avatarSvg } from '../lib/art.ts';
import { chainDotClass, shortAddr, timeLeft } from '../lib/format.ts';
import { CHAIN_NAMES } from '../wagmi.ts';

/** Header wallet control: connect → network warning → account chip with menu. */
export function WalletButton({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const auth = useAuth();
  return (
    <ConnectButton.Custom>
      {({ account, chain, openConnectModal, openAccountModal, mounted }) => {
        if (!mounted) return <span className="sr-only">Loading wallet</span>;
        if (!account) {
          return (
            <button className={`btn btn-primary ${size === 'lg' ? 'btn-lg' : ''}`} onClick={openConnectModal}>
              Connect wallet
            </button>
          );
        }
        const hub = auth.config?.chainId;
        if (hub && chain?.id !== hub && auth.status !== 'signedIn') {
          return (
            <button className="chip warn" onClick={auth.switchToHub}>
              Switch to {CHAIN_NAMES[hub] ?? `chain ${hub}`}
            </button>
          );
        }
        if (auth.status !== 'signedIn') {
          return (
            <button className="chip" onClick={openAccountModal} title="Wallet connected, not signed in">
              <img className="avatar" src={avatarSvg(account.address)} alt="" />
              <span className="addr">{shortAddr(account.address)}</span>
            </button>
          );
        }
        return <AccountMenu />;
      }}
    </ConnectButton.Custom>
  );
}

function AccountMenu() {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [, tick] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const me = auth.me!;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); clearInterval(t); };
  }, [open]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(me.address); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* ignore */ }
  };
  const hub = auth.config?.chainId;

  return (
    <div className="menu-wrap" ref={ref}>
      <button className="chip" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <img className="avatar" src={avatarSvg(me.address)} alt="" />
        <span className="addr">{shortAddr(me.address)}</span>
        <span className={`dot ${chainDotClass(hub)}`} title={CHAIN_NAMES[hub ?? 0]} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <img className="avatar" src={avatarSvg(me.address)} alt="" />
            <div>
              <div className="mono">{shortAddr(me.address)}</div>
              <div className="badges" style={{ marginTop: 4 }}>
                {me.verifiedHuman && <span className="badge human">Verified human</span>}
                {me.agent && <span className="badge agent">Agent</span>}
                {me.bannedFromRanked && <span className="badge banned">Ranked ban</span>}
                {!me.verifiedHuman && !me.agent && <span className="badge">Player</span>}
              </div>
            </div>
          </div>
          <div className="menu-row"><span>Network</span><b><span className={`dot ${chainDotClass(hub)}`} /> {CHAIN_NAMES[hub ?? 0] ?? hub}</b></div>
          <div className="menu-row"><span>Session key</span><b className="mono">{shortAddr(me.sessionKey)}</b></div>
          <div className="menu-row"><span>Session ends in</span><b>{auth.expiresAt ? timeLeft(auth.expiresAt - Date.now()) : '–'}</b></div>
          <hr />
          <button className="item" role="menuitem" onClick={copy}>{copied ? 'Copied ✓' : 'Copy address'}</button>
          <button className="item" role="menuitem" onClick={() => { setOpen(false); auth.signOut(); }}>Sign out <span className="muted">(keep wallet connected)</span></button>
          <button className="item btn-danger" role="menuitem" onClick={() => { setOpen(false); auth.disconnect(); }}>Disconnect wallet</button>
        </div>
      )}
    </div>
  );
}
