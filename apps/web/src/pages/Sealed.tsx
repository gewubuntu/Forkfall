import {
  autoBuildSealed, card, DECK_SIZE, SEALED_BASIC_COPIES, SEALED_BASICS, SEALED_LOSSES, SEALED_WINS, sealedAllowed, sealedPool,
  sealedPrize, validateSealedDeck,
} from '@forkfall/engine';
import { verifySealedRun, type QuestPayoutStatus, type SealedRunView, type SealedStatus } from '@forkfall/sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider.tsx';
import { friendlyError } from '../chain/errors.ts';
import { GameCard } from '../components/GameCard.tsx';
import { ManaCurve } from '../components/ManaCurve.tsx';
import { PackReveal } from '../components/PackReveal.tsx';
import { timeLeft } from '../lib/format.ts';
import { useLiveTopic } from '../lib/live.ts';

const FOIL_OFFSET = 20_000;
const openedKey = (id: string) => `forkfall.sealed.opened.${id}`;
const loadOpened = (id: string) => { try { return Number(localStorage.getItem(openedKey(id)) ?? 0) || 0; } catch { return 0; } };
const saveOpened = (id: string, n: number) => { try { localStorage.setItem(openedKey(id), String(n)); } catch { /* ignore */ } };

export function prizeText(wins: number): string {
  const p = sealedPrize(wins);
  const parts = [p.packs ? `${p.packs} pack${p.packs === 1 ? '' : 's'}` : '', p.scrap ? `${p.scrap} Scrap` : '', p.titleStep ? 'the Unsealed title' : ''].filter(Boolean);
  return parts.join(' + ');
}

function Payout({ p }: { p?: QuestPayoutStatus }) {
  if (!p || p.state === 'offchain') return <span className="q-tag ok">✓ Earned</span>;
  if (p.state === 'paid') return <span className="q-tag ok" title={p.tx}>✓ Paid</span>;
  if (p.state === 'held') return <Link className="q-tag held" to="/profile" title="Verify as human on your Profile to receive it">🔒 Held</Link>;
  if (p.state === 'failed') return <span className="q-tag err" title={p.error}>Payout failed</span>;
  return <span className="q-tag pending"><span className="spinner" /> Paying</span>;
}

/** Wins and losses of a run as dots: 7 to win, out at 3 losses. */
export function Record({ run }: { run: Pick<SealedRunView, 'wins' | 'losses'> }) {
  return (
    <div className="sl-record" role="img" aria-label={`${run.wins} wins, ${run.losses} losses`}>
      <span className="sl-dots">{Array.from({ length: SEALED_WINS }, (_, i) => <i key={i} className={i < run.wins ? 'w' : ''} />)}</span>
      <span className="sl-dots l">{Array.from({ length: SEALED_LOSSES }, (_, i) => <i key={i} className={i < run.losses ? 'l' : ''} />)}</span>
      <b>{run.wins}–{run.losses}</b>
    </div>
  );
}

/** Sealed: open 6 packs, build a 30-card deck from them, play until 7 wins or 3 losses. */
export function Sealed() {
  const { client, me } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const key = ['sealed', me?.address];
  const q = useQuery({
    queryKey: key,
    queryFn: () => client!.sealedStatus(),
    enabled: !!client,
    retry: false,
    refetchInterval: (query) => (query.state.data?.run?.queued || query.state.data?.run?.activeMatch ? 2000 : 30_000),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = q.data;
  const act = async (fn: () => Promise<SealedStatus>) => {
    setError(null); setBusy(true);
    try { qc.setQueryData(key, await fn()); } catch (e) { setError(friendlyError(e)); } finally { setBusy(false); }
  };
  useLiveTopic(client ? 'me' : null, (e) => { if (e.kind === 'match' || e.kind === 'reconnect') qc.invalidateQueries({ queryKey: key }); });

  // Matched (by a person or the house bot): jump straight into the match.
  const wasQueued = useRef(false);
  const run = s?.run ?? null;
  useEffect(() => {
    if (run?.queued) wasQueued.current = true;
    else if (run?.activeMatch && wasQueued.current) { wasQueued.current = false; navigate(`/match/${run.activeMatch.id}`); }
  }, [run?.queued, run?.activeMatch, navigate]);

  if (q.isLoading) return <div className="page"><span className="spinner" aria-label="Loading" /></div>;
  if (q.isError || !s) return <div className="page"><div className="panel empty"><h2>No Sealed here</h2><p>This server doesn’t run Sealed.</p></div></div>;

  return (
    <div className="page sealed-page">
      <header className="sl-hero">
        <div>
          <span className="pass-kicker">Casual · unrated</span>
          <h1>Sealed</h1>
          <p className="muted">
            Open {s.rules.packs} packs, build a 30-card deck from what you pulled (plus free basics, any races), then play until {s.rules.wins} wins or {s.rules.losses} losses.
            One free run a day.
          </p>
        </div>
        {s.titles.length > 0 && <Link className="btn btn-ghost" to="/collection">Your Sealed titles</Link>}
      </header>
      {error && <p className="err" role="alert">{error}</p>}
      {!run && <Start s={s} busy={busy} onStart={() => act(() => client!.sealedStart())} />}
      {run && <RunView run={run} busy={busy} act={act} botAfterMs={s.rules.botAfterMs} />}
      {s.history.length > 0 && (
        <section className="panel" aria-labelledby="sl-hist">
          <h2 id="sl-hist">Past runs</h2>
          <ul className="sl-hist">{s.history.map((r) => <HistoryRow key={r.id} r={r} />)}</ul>
        </section>
      )}
    </div>
  );
}

function Start({ s, busy, onStart }: { s: SealedStatus; busy: boolean; onStart: () => void }) {
  return (
    <section className="panel sl-start" aria-labelledby="sl-start-h">
      <h2 id="sl-start-h">{s.canStart ? 'Start today’s free run' : 'Today’s free run is used'}</h2>
      <div className="sl-prizes">
        <h3 className="small">Prizes by wins</h3>
        <ul>{Array.from({ length: SEALED_WINS + 1 }, (_, w) => <li key={w}><b>{w}</b><span>{prizeText(w)}</span></li>)}</ul>
      </div>
      <p className="small muted">
        Your pool is rolled from a seed the referee committed to before you start, mixed with your own random share, so neither side picks your cards.
        When the run ends you can check it yourself. If nobody is queued with you, a house bot plays you after {s.rules.botAfterMs / 1000} seconds.
      </p>
      <p className="mono small muted">Commitment: {s.pending.commit.slice(0, 18)}…</p>
      {s.canStart
        ? <button className="btn btn-primary" disabled={busy} onClick={onStart}>Start run</button>
        : <p className="muted">Next free run {s.nextStartAt ? `in ${timeLeft(s.nextStartAt - Date.now())}` : 'tomorrow'} (UTC midnight).</p>}
    </section>
  );
}

function RunView({ run, busy, act, botAfterMs }: { botAfterMs: number; run: SealedRunView; busy: boolean; act: (fn: () => Promise<SealedStatus>) => Promise<void> }) {
  const { client } = useAuth();
  const [opened, setOpened] = useState(() => loadOpened(run.id));
  const [revealing, setRevealing] = useState<number | null>(null);
  const open = (n: number) => { setOpened((o) => { const v = Math.max(o, n + 1); saveOpened(run.id, v); return v; }); setRevealing(null); };
  const allOpened = opened >= run.packs.length;
  const next = revealing !== null && revealing + 1 < run.packs.length ? () => { open(revealing); setRevealing(revealing + 1); } : undefined;

  return (
    <>
      <section className="panel sl-run" aria-labelledby="sl-run-h">
        <div className="sl-run-head">
          <h2 id="sl-run-h">Your run</h2>
          <Record run={run} />
        </div>
        {!allOpened && (
          <div className="sl-packs">
            <p className="muted">Your {run.packs.length} packs are sealed. Open them to see your pool.</p>
            <div className="sl-pack-row">
              {run.packs.map((_, i) => (
                <button key={i} className={`sl-pack ${i < opened ? 'done' : ''}`} onClick={() => setRevealing(i)} aria-label={`${i < opened ? 'Look again at' : 'Open'} pack ${i + 1}`}>
                  <span>{i < opened ? '✓' : '🎴'}</span><small>Pack {i + 1}</small>
                </button>
              ))}
            </div>
            <button className="btn btn-ghost" onClick={() => { saveOpened(run.id, run.packs.length); setOpened(run.packs.length); }}>Skip the animations</button>
          </div>
        )}
        {revealing !== null && (
          <PackReveal
            ids={run.packs[revealing].map((c) => (c.foil ? c.id + FOIL_OFFSET : c.id))}
            fresh={run.packs[revealing].map(() => false)}
            onClose={() => open(revealing)}
            next={next}
          />
        )}
        {allOpened && <Builder run={run} busy={busy} act={act} />}
        {allOpened && run.deck && <Play run={run} busy={busy} act={act} botAfterMs={botAfterMs} />}
      </section>
      <section className="panel sl-abandon">
        <button className="btn btn-ghost btn-sm" disabled={busy || !!run.activeMatch} onClick={() => { if (confirm('End this run now? You keep your record so far, and a run with no matches pays nothing.')) act(() => client!.sealedAbandon()); }}>End run</button>
      </section>
    </>
  );
}

function Builder({ run, busy, act }: { run: SealedRunView; busy: boolean; act: (fn: () => Promise<SealedStatus>) => Promise<void> }) {
  const { client } = useAuth();
  const pool = useMemo(() => sealedPool(run.packs), [run.packs]);
  const foils = useMemo(() => new Set(run.packs.flat().filter((c) => c.foil).map((c) => c.id)), [run.packs]);
  const [deck, setDeck] = useState<number[]>(run.deck ?? []);
  const [hover, setHover] = useState<number | null>(null);
  const locked = !!run.queued || !!run.activeMatch;
  const ids = useMemo(() => [...new Set([...pool.keys(), ...SEALED_BASICS])].filter((id) => sealedAllowed(pool, id) > 0).sort((a, b) => card(a).cost - card(b).cost || card(a).name.localeCompare(card(b).name)), [pool]);
  const count = (id: number) => deck.filter((x) => x === id).length;
  const check = validateSealedDeck(deck, pool);
  const dirty = JSON.stringify([...deck].sort((a, b) => a - b)) !== JSON.stringify([...(run.deck ?? [])].sort((a, b) => a - b));
  const add = (id: number) => { if (deck.length < DECK_SIZE && count(id) < sealedAllowed(pool, id)) setDeck([...deck, id]); };
  const remove = (id: number) => { const i = deck.lastIndexOf(id); if (i >= 0) setDeck(deck.filter((_, j) => j !== i)); };
  const sorted = [...new Set(deck)].sort((a, b) => card(a).cost - card(b).cost || card(a).name.localeCompare(card(b).name));

  return (
    <div className="sl-build">
      <div className="sl-pool">
        <h3>Your pool <span className="muted small">click to add · basics are free, up to {SEALED_BASIC_COPIES} each</span></h3>
        <div className="sl-grid">
          {ids.map((id) => {
            const left = sealedAllowed(pool, id) - count(id);
            return (
              <div key={id} className={`sl-slot ${left <= 0 ? 'out' : ''}`}>
                <GameCard cardId={id} size="mini" foil={foils.has(id)} dimmed={left <= 0} onClick={locked ? undefined : () => add(id)} onHover={setHover} />
                <span className="sl-left" aria-label={`${left} left`}>×{Math.max(left, 0)}{SEALED_BASICS.includes(id) ? ' free' : ''}</span>
              </div>
            );
          })}
        </div>
      </div>
      <aside className="sl-deck" aria-label="Your deck">
        <h3>Deck <b className={check.ok ? 'ok' : ''}>{deck.length}/{DECK_SIZE}</b></h3>
        <ManaCurve costs={deck.map((id) => card(id).cost)} />
        <ul className="sl-deck-list">
          {sorted.map((id) => (
            <li key={id}>
              <button className="sl-row" disabled={locked} onClick={() => remove(id)} onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover(null)} aria-label={`Remove one ${card(id).name}`}>
                <span className="sl-cost">{card(id).cost}</span><span className="sl-nm">{card(id).name}</span><span className="sl-n">×{count(id)}</span>
              </button>
            </li>
          ))}
        </ul>
        {!check.ok && deck.length > 0 && deck.length === DECK_SIZE && <p className="err small">{check.errors[0]}</p>}
        <div className="sl-actions">
          <button className="btn btn-ghost" disabled={locked} onClick={() => setDeck(autoBuildSealed(pool))}>Build for me</button>
          <button className="btn btn-primary" disabled={busy || locked || !check.ok || !dirty} onClick={() => act(() => client!.sealedDeck(deck))}>{run.deck && !dirty ? 'Deck saved' : 'Save deck'}</button>
        </div>
        {hover !== null && <div className="hover-preview" aria-hidden><GameCard cardId={hover} size="preview" /></div>}
      </aside>
    </div>
  );
}

function Play({ run, busy, act, botAfterMs }: { botAfterMs: number; run: SealedRunView; busy: boolean; act: (fn: () => Promise<SealedStatus>) => Promise<void> }) {
  const { client } = useAuth();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  if (run.activeMatch) {
    return <div className="sl-play"><Link className="btn btn-primary" to={`/match/${run.activeMatch.id}`}>Go to your match</Link></div>;
  }
  if (run.queued) {
    const left = Math.max(0, run.queued.botAt - Date.now());
    return (
      <div className="sl-play" role="status">
        <p><span className="spinner" /> Looking for a player with a similar record…</p>
        <p className="muted small">
          {left > 0 ? <>If nobody joins in <b>{Math.ceil(left / 1000)} s</b>, you’ll play a house bot.</> : 'Matching you with a house bot…'}
        </p>
        <button className="btn btn-ghost" disabled={busy} onClick={() => act(() => client!.sealedLeave())}>Leave queue</button>
      </div>
    );
  }
  return (
    <div className="sl-play">
      <button className="btn btn-primary" disabled={busy} onClick={() => act(() => client!.sealedQueue(run.id))}>Find a match</button>
      <p className="muted small">Players with your record are matched first. If nobody is queued, a house bot plays you after {botAfterMs / 1000} seconds. Best of one.</p>
    </div>
  );
}

function HistoryRow({ r }: { r: SealedRunView }) {
  const [open, setOpen] = useState(false);
  const proof = useMemo(() => (open ? verifySealedRun(r) : null), [open, r]);
  return (
    <li className="sl-hrow">
      <div className="sl-hmain">
        <Record run={r} />
        <span className="small muted">{r.endedBy === 'wins' ? 'Seven wins!' : r.endedBy === 'losses' ? 'Out at three losses' : r.endedBy === 'expired' ? 'Expired' : 'Ended early'} · {new Date(r.startedAt).toLocaleDateString()}</span>
        {r.prize ? <span className="sl-prize">🎁 {prizeText(r.wins) || 'No prize'} <Payout p={r.prize.payout} /></span> : <span className="small muted">No prize (no matches played)</span>}
        <button className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide proof' : 'Verify pool'}</button>
      </div>
      {proof && (
        <p className={`small ${proof.ok ? 'ok' : 'err'}`} role="status">
          {proof.ok ? '✓ ' : '✗ '}{proof.detail}. <span className="mono">commit {r.commit.slice(0, 14)}… seed {r.serverSeed?.slice(0, 14)}…</span>
        </p>
      )}
    </li>
  );
}
