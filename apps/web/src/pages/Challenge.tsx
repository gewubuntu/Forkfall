import { RACES, type Race } from '@forkfall/engine';
import type { ChallengeView } from '@forkfall/sdk';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider.tsx';
import { friendlyError } from '../chain/errors.ts';
import { ChallengeWaiting, Challenger } from '../components/Challenges.tsx';
import { WalletButton } from '../components/WalletButton.tsx';
import { RACE_INFO } from '../game/meta.ts';
import { spriteSvg } from '../lib/art.ts';
import { shortAddr, timeLeft } from '../lib/format.ts';
import { SignInGate } from './SignInGate.tsx';

const SERVER = import.meta.env.VITE_SERVER_URL ?? '';

/**
 * /challenge/<code>: someone challenged you. Works before you connect: shows who challenged you, then walks you
 * through connecting and signing in, picking a race, and accepting (straight into the match).
 */
export function Challenge() {
  const { code = '' } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const [c, setC] = useState<ChallengeView | null>(null);
  const [missing, setMissing] = useState(false);
  const [race, setRace] = useState<Race>('agents');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const signedIn = auth.status === 'signedIn';

  useEffect(() => {
    let alive = true;
    const load = auth.client
      ? auth.client.challenge(code)
      : fetch(`${SERVER}/v1/challenges/${code}`).then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<ChallengeView>; });
    load.then((x) => { if (alive) setC(x); }).catch(() => { if (alive) setMissing(true); });
    return () => { alive = false; };
  }, [code, auth.client]);

  const me = auth.me?.address.toLowerCase();
  const mine = !!c && !!me && c.from.address.toLowerCase() === me;
  const forSomeoneElse = !!c?.to && !!me && c.to.toLowerCase() !== me;

  const accept = async () => {
    setErr(null); setBusy(true);
    try { navigate(`/match/${await auth.client!.acceptChallenge(code, { race })}`); } catch (e) { setErr(friendlyError(e)); setBusy(false); }
  };

  if (missing) {
    return <div className="gate"><div className="card"><h2>Challenge not found</h2><p className="lead">The link may be mistyped, or the challenge expired over a day ago.</p><Link className="btn" to="/">Home</Link></div></div>;
  }
  if (!c) return <div className="gate"><span className="spinner" aria-label="Loading" /></div>;
  if (signedIn && mine) {
    return (
      <div className="page challenge-page">
        <h1>Your challenge</h1>
        <div className="panel"><ChallengeWaiting code={code} onDone={() => navigate('/play')} /></div>
      </div>
    );
  }

  const closed = c.state !== 'open';
  return (
    <div className="page challenge-page">
      <div className="panel challenge-card">
        <span className="ch-kicker">⚔ Forkfall challenge</span>
        <h1><Challenger c={c} /></h1>
        <p className="lead">{c.rematchOf ? 'wants a rematch.' : 'challenges you to a casual match.'} Five-minute duel, four crypto-native races, no rating at stake.</p>
        <p className="muted small">
          {c.to ? <>For {shortAddr(c.to)} only. </> : null}
          {closed ? `This challenge was ${c.state}.` : `Expires in ${timeLeft(c.expiresAt - Date.now())}.`}
        </p>

        {closed ? <Link className="btn btn-primary" to="/play">Find another match</Link>
          : forSomeoneElse ? <p className="hint warn">This challenge is for another wallet ({shortAddr(c.to!)}). Ask your friend for an open link.</p>
          : !signedIn ? (
            auth.status === 'disconnected' ? (
              <div className="ch-connect">
                <p>Connect a wallet to accept. New to Forkfall? <Link to="/learn/basics">Learn to play in 3 minutes</Link> first, no wallet needed.</p>
                <WalletButton size="lg" />
              </div>
            ) : auth.status === 'loading' || auth.status === 'offline' ? null : <SignInGate />
          ) : (
            <>
              <h2 className="sub">Pick your race</h2>
              <div className="race-pick" role="radiogroup" aria-label="Race">
                {RACES.map((r) => (
                  <button key={r} role="radio" aria-checked={race === r} className={`race-opt ${race === r ? 'on' : ''}`} style={{ ['--rc' as string]: `var(--${r})` }} onClick={() => setRace(r)}>
                    <img src={spriteSvg(RACE_INFO[r].sprite)} alt="" />
                    <span className="ro-text"><b>{RACE_INFO[r].name}</b><small>{RACE_INFO[r].style}</small></span>
                  </button>
                ))}
              </div>
              <p className="muted small">Your race’s starter deck is used. Their race stays hidden until the match starts.</p>
              {err && <div className="alert err">{err}</div>}
              <button className="btn btn-primary btn-lg" onClick={accept} disabled={busy}>{busy ? <span className="spinner" /> : null} Accept challenge</button>
            </>
          )}
      </div>
    </div>
  );
}
