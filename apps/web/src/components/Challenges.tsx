import { emblem } from '../lib/cosmetics.ts';
import { cosmetic } from '@forkfall/engine';
import type { ChallengeView } from '@forkfall/sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider.tsx';
import { friendlyError } from '../chain/errors.ts';
import { avatarSvg } from '../lib/art.ts';
import { useLiveTopic } from '../lib/live.ts';
import { shortAddr, timeLeft } from '../lib/format.ts';

/** The challenge you're waiting on, kept per tab so a reload resumes it. */
const WAITING_KEY = 'ff.challenge.waiting';
export const loadWaiting = (): string | null => { try { return sessionStorage.getItem(WAITING_KEY); } catch { return null; } };
export const saveWaiting = (code: string | null) => {
  try { if (code) sessionStorage.setItem(WAITING_KEY, code); else sessionStorage.removeItem(WAITING_KEY); } catch { /* private mode */ }
};
/** Forget the saved Play challenge, but only if it's this one (a rematch never touches it). */
const clearWaiting = (code: string) => { if (loadWaiting() === code) saveWaiting(null); };

/**
 * Your challenges and the ones addressed to you (shared by every component that asks). Refetched when the referee
 * pushes a challenge or match notice; polled every 5 s only while the live socket is down.
 */
export function useChallenges() {
  const { client, me } = useAuth();
  const qc = useQueryClient();
  const key = ['challenges', me?.address];
  const up = useLiveTopic(client ? 'me' : null, (e) => {
    if (e.kind === 'challenge' || e.kind === 'match' || e.kind === 'reconnect') qc.invalidateQueries({ queryKey: key });
  });
  return useQuery({ queryKey: key, queryFn: () => client!.challenges(), enabled: !!client, refetchInterval: up ? 60_000 : 5000, retry: false });
}

export const challengeLink = (code: string) => `${location.origin}/challenge/${code}`;

/** Who sent a challenge: avatar, address, and their equipped title. */
export function Challenger({ c }: { c: ChallengeView }) {
  const title = c.from.cosmetics?.title;
  return (
    <span className="challenger">
      <img className="avatar sm" src={avatarSvg(c.from.address)} alt="" />
      <span>
        <b className="mono">{shortAddr(c.from.address)}</b>
        {c.from.agent && <span className="badge agent">Agent</span>}
        {title && <span className="cos-title">{emblem(title)} {cosmetic(title)?.name}</span>}
      </span>
    </span>
  );
}

/**
 * Your open challenge: the link to share, then straight into the match when it's accepted (pushed over the live
 * socket; polls every 2 s only while it's down).
 * `rematch` changes the copy for the result screen.
 */
export function ChallengeWaiting({ code, onDone, rematch = false }: { code: string; onDone: () => void; rematch?: boolean }) {
  const { client } = useAuth();
  const navigate = useNavigate();
  const [c, setC] = useState<ChallengeView | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const poll = useCallback(async () => {
    if (!client) return;
    try {
      const x = await client.challenge(code);
      if (!mounted.current) return;
      setC(x);
      if (x.matchId && (x.matchPhase === 'reveal' || x.matchPhase === 'active')) { clearWaiting(code); navigate(`/match/${x.matchId}`); return; }
      if (x.state !== 'open') clearWaiting(code);
    } catch (e) { setErr(friendlyError(e)); }
  }, [client, code, navigate]);
  const up = useLiveTopic(client ? 'me' : null, (e) => {
    if ((e.kind === 'challenge' && e.code === code) || e.kind === 'match' || e.kind === 'reconnect') poll();
  });
  useEffect(() => {
    poll();
    const t = setInterval(poll, up ? 30_000 : 2000);
    return () => clearInterval(t);
  }, [poll, up]);

  const link = challengeLink(code);
  const copy = async () => { await navigator.clipboard.writeText(link).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const share = () => navigator.share?.({ title: 'Forkfall challenge', text: 'I challenge you to a Forkfall match!', url: link }).catch(() => {});
  const cancel = async () => {
    try { await client!.cancelChallenge(code); } catch { /* already closed */ }
    clearWaiting(code); onDone();
  };

  if (c && c.state !== 'open' && !c.matchId) {
    return (
      <div className="challenge-wait closed" role="status">
        <b>{c.state === 'declined' ? 'They declined the challenge.' : c.state === 'expired' ? 'The challenge expired.' : 'Challenge closed.'}</b>
        <button className="btn" onClick={() => { clearWaiting(code); onDone(); }}>OK</button>
      </div>
    );
  }
  return (
    <div className="challenge-wait" role="status">
      <div className="cw-head">
        <span className="radar" aria-hidden />
        <div>
          <b>{rematch ? 'Rematch sent: waiting for your opponent…' : c?.to ? `Waiting for ${shortAddr(c.to)}…` : 'Waiting for your friend to accept…'}</b>
          <div className="muted small">{c ? `Expires in ${timeLeft(c.expiresAt - Date.now())}` : ' '}</div>
        </div>
      </div>
      {!rematch && (
        <div className="cw-link">
          <input readOnly value={link} aria-label="Challenge link" onFocus={(e) => e.currentTarget.select()} />
          <button className="btn" onClick={copy}>{copied ? '✓ Copied' : 'Copy link'}</button>
          {'share' in navigator && <button className="btn btn-ghost" onClick={share}>Share</button>}
        </div>
      )}
      {err && <div className="alert err">{err}</div>}
      <button className="btn btn-ghost" onClick={cancel}>Cancel challenge</button>
    </div>
  );
}

/** Challenges addressed to you (directed challenges and rematches), with Accept / Decline. */
export function IncomingChallenges() {
  const { client } = useAuth();
  const qc = useQueryClient();
  const q = useChallenges();
  const incoming = q.data?.incoming ?? [];
  if (!incoming.length) return null;
  const decline = async (code: string) => {
    await client!.cancelChallenge(code).catch(() => {});
    qc.invalidateQueries({ queryKey: ['challenges'] });
  };
  return (
    <section className="panel incoming" aria-labelledby="incoming-h">
      <h2 id="incoming-h">⚔ Challenges for you</h2>
      <ul>
        {incoming.map((c) => (
          <li key={c.code}>
            <Challenger c={c} />
            <span className="muted small">{c.rematchOf ? 'wants a rematch' : 'challenges you'} · casual · {timeLeft(c.expiresAt - Date.now())} left</span>
            <span className="inc-actions">
              <button className="btn btn-ghost" onClick={() => decline(c.code)}>Decline</button>
              <Link className="btn btn-primary" to={`/challenge/${c.code}`}>Accept</Link>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Anywhere in the app: one of your challenges was just accepted and its match is waiting for you to join.
 * (You might have left the waiting screen; the match starts once you're in, or the link reopens after 3 minutes.)
 */
export function ChallengeAlert() {
  const q = useChallenges();
  const path = useLocation().pathname;
  const ready = q.data?.outgoing.find((c) => c.matchId && c.matchPhase === 'reveal' && !path.endsWith(c.matchId));
  if (!ready) return null;
  return (
    <div className="toast challenge-alert" role="alert">
      <span>⚔ Your challenge was accepted!</span>
      <Link className="btn btn-primary" to={`/match/${ready.matchId}`}>Join match</Link>
    </div>
  );
}
