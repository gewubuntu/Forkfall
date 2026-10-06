import { useState } from 'react';
import { useConnection } from 'wagmi';
import { useAuth } from '../auth/AuthProvider.tsx';
import { InviteBanner } from '../components/InviteBanner.tsx';
import { avatarSvg } from '../lib/art.ts';
import { chainDotClass, shortAddr } from '../lib/format.ts';
import { SESSION_LENGTHS } from '../lib/session.ts';
import { CHAIN_NAMES } from '../wagmi.ts';

/** Shown after the wallet connects: switch network if needed, then sign the session message once. */
export function SignInGate() {
  const auth = useAuth();
  const { chain, connector } = useConnection();
  const [hours, setHours] = useState(8);
  const hub = auth.config!.chainId;
  const hubName = CHAIN_NAMES[hub] ?? `chain ${hub}`;
  const wrongChain = auth.status === 'wrongChain';
  const busy = auth.status === 'signingIn';

  return (
    <div className="gate">
      <div className="card">
        <h2>{wrongChain ? 'Switch network' : 'Sign in to play'}</h2>
        <p className="lead">
          {wrongChain
            ? `Forkfall settles matches on ${hubName}. Switch your wallet to it to continue.`
            : 'Sign one message to start a play session. No transaction, no gas.'}
        </p>

        {!wrongChain && <InviteBanner />}
        <div className="who">
          <img className="avatar" src={avatarSvg(auth.wallet!)} alt="" />
          <div style={{ flex: 1 }}>
            <div className="addr">{shortAddr(auth.wallet)}</div>
            <div className="net">
              <span className={`dot ${chainDotClass(chain?.id)}`} style={wrongChain ? { background: 'var(--warn)' } : undefined} />
              {chain?.name ?? 'Unsupported network'}{connector ? ` · ${connector.name}` : ''}
            </div>
          </div>
          <button className="btn btn-ghost" onClick={auth.disconnect}>Disconnect</button>
        </div>

        {auth.error && (
          <div className="alert err" role="alert"><span>{auth.error}</span><button onClick={auth.clearError} aria-label="Dismiss">✕</button></div>
        )}

        {wrongChain ? (
          <button className="btn btn-primary btn-lg btn-block" onClick={auth.switchToHub}>Switch to {hubName}</button>
        ) : (
          <>
            <ul className="facts">
              <li><span className="yes">✓</span><span>Authorizes a temporary key in this browser to sign your <b>game moves</b>.</span></li>
              <li><span className="yes">✓</span><span>Your wallet still signs every <b>match result</b> before it settles on-chain.</span></li>
              <li><span className="no">✕</span><span>Cannot transfer tokens, cards or ETH, and expires on its own.</span></li>
            </ul>
            <div className="seg-label">Session length</div>
            <div className="seg" role="radiogroup" aria-label="Session length">
              {SESSION_LENGTHS.map((s) => (
                <button key={s.hours} role="radio" aria-checked={hours === s.hours} className={hours === s.hours ? 'on' : ''} onClick={() => setHours(s.hours)}>
                  {s.label}
                </button>
              ))}
            </div>
            <button className="btn btn-primary btn-lg btn-block" disabled={busy} onClick={() => auth.signIn(hours)}>
              {busy ? <><span className="spinner" /> Check your wallet…</> : 'Sign in with wallet'}
            </button>
            <div className="row"><span className="muted" style={{ fontSize: 12.5 }}>Sign-In with Ethereum (EIP-4361) · {hubName}</span></div>
          </>
        )}
      </div>
    </div>
  );
}
