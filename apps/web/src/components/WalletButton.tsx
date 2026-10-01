import { useEffect, useRef, useState } from 'react';
import { useConnection } from 'wagmi';
import { useAuth } from '../auth/AuthProvider.tsx';
import { avatarSvg } from '../lib/art.ts';
import { chainDotClass, shortAddr, timeLeft } from '../lib/format.ts';
import { CHAIN_NAMES } from '../wagmi.ts';
import { useConnectModal } from './ConnectModal.tsx';

/** Header wallet control: connect → network warning → account chip with menu. */
export function WalletButton({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const auth = useAuth();
  const { address, chainId, isConnected } = useConnection();
  const modal = useConnectModal();
  if (!isConnected || !address) {
    return (
      <button className={`btn btn-primary ${size === 'lg' ? 'btn-lg' : ''}`} onClick={modal.open}>
        Connect wallet
      </button>
    );
  }
  const hub = auth.config?.chainId;
  if (hub && chainId !== hub && auth.status !== 'signedIn') {
    return (
      <button className="chip warn" onClick={auth.switchToHub}>
        Switch to {CHAIN_NAMES[hub] ?? `chain ${hub}`}
      </button>
    );
  }
  return <AccountMenu />;
}

function AccountMenu() {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [, tick] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const { address } = useConnection();
  const me = auth.me;
  const wallet = (me?.address ?? address)!;

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
    try { await navigator.clipboard.writeText(wallet); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* ignore */ }
  };
  const hub = auth.config?.chainId;

  return (
    <div className="menu-wrap" ref={ref}>
      <button className="chip" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <img className="avatar" src={avatarSvg(wallet)} alt="" />
        <span className="addr">{shortAddr(wallet)}</span>
        {me && <span className={`dot ${chainDotClass(hub)}`} title={CHAIN_NAMES[hub ?? 0]} />}
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <img className="avatar" src={avatarSvg(wallet)} alt="" />
            <div>
              <div className="mono">{shortAddr(wallet)}</div>
              <div className="badges" style={{ marginTop: 4 }}>
                {!me && <span className="badge">Not signed in</span>}
                {me?.verifiedHuman && <span className="badge human">Verified human</span>}
                {me?.agent && <span className="badge agent">Agent</span>}
                {me?.bannedFromRanked && <span className="badge banned">Ranked ban</span>}
                {me && !me.verifiedHuman && !me.agent && <span className="badge">Player</span>}
              </div>
            </div>
          </div>
          {me && <>
            <div className="menu-row"><span>Network</span><b><span className={`dot ${chainDotClass(hub)}`} /> {CHAIN_NAMES[hub ?? 0] ?? hub}</b></div>
            <div className="menu-row"><span>Session key</span><b className="mono">{shortAddr(me.sessionKey)}</b></div>
            <div className="menu-row"><span>Session ends in</span><b>{auth.expiresAt ? timeLeft(auth.expiresAt - Date.now()) : '–'}</b></div>
          </>}
          <hr />
          <button className="item" role="menuitem" onClick={copy}>{copied ? 'Copied ✓' : 'Copy address'}</button>
          {me && <button className="item" role="menuitem" onClick={() => { setOpen(false); auth.signOut(); }}>Sign out <span className="muted">(keep wallet connected)</span></button>}
          <button className="item btn-danger" role="menuitem" onClick={() => { setOpen(false); auth.disconnect(); }}>Disconnect wallet</button>
        </div>
      )}
    </div>
  );
}
