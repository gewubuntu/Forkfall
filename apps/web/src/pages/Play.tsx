import { BEATS, RACES, type Race } from '@forkfall/engine';
import type { Mode } from '@forkfall/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { Address, Hex } from 'viem';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useMyDecks } from '../chain/useMyDecks.ts';
import { LearnBanner } from '../components/LearnBanner.tsx';
import { deckName } from '../lib/deckNames.ts';
import { RACE_INFO, raceName } from '../game/meta.ts';
import { spriteSvg } from '../lib/art.ts';
import { shortAddr } from '../lib/format.ts';

type Tab = 'practice' | Mode;
const TABS: { id: Tab; label: string; blurb: string }[] = [
  { id: 'practice', label: 'Practice', blurb: 'Play the house bot. Nothing at stake, starts instantly.' },
  { id: 'casual', label: 'Casual', blurb: 'Humans and agents, no rating. Uses your race’s starter deck.' },
  { id: 'ranked', label: 'Ranked', blurb: 'Season Elo for humans and agents together. Needs a registered, ranked-legal deck.' },
  { id: 'human', label: 'Human queue', blurb: 'Humans only: no registered agents. Rated like Ranked; needs a registered deck. Verify on your profile to earn rewards.' },
];

interface LiveMatch {
  matchId: Hex; mode: string; phase: string; turn: number;
  players: { address: string; race: Race; agent: boolean }[];
}

const PREF = 'forkfall.play.v1';
function loadPref(): { race: Race; tab: Tab; deckId: string } {
  try { return { race: 'agents', tab: 'practice', deckId: '', ...JSON.parse(localStorage.getItem(PREF) ?? '{}') }; }
  catch { return { race: 'agents', tab: 'practice', deckId: '' }; }
}

export function Play() {
  const { client, me, config } = useAuth();
  const navigate = useNavigate();
  const [pref, setPref] = useState(loadPref);
  const [botRace, setBotRace] = useState<Race | 'random'>('random');
  const [botLevel, setBotLevel] = useState<'greedy' | 'random'>('greedy');
  const [searching, setSearching] = useState<{ mode: Mode; since: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveMatch[]>([]);
  const [, tick] = useState(0);

  const { decks } = useMyDecks(me?.address as Address | undefined);
  const [params, setParams] = useSearchParams();

  // Arriving from Decks with ?deck=<id>: select that deck, its race, and the best mode for it (once,
  // after the deck list loads), then drop the param so a reload doesn't re-apply it.
  const wantDeck = params.get('deck')?.toLowerCase() ?? null;
  const appliedDeck = useRef<string | null>(null);
  useEffect(() => {
    if (!wantDeck || appliedDeck.current === wantDeck) return;
    const d = decks.find((x) => x.id.toLowerCase() === wantDeck);
    if (!d) return;
    appliedDeck.current = wantDeck;
    update({ race: d.race, deckId: d.id, tab: d.rankedLegal ? 'ranked' : 'casual' });
    setParams({}, { replace: true });
  }, [wantDeck, decks]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (p: Partial<typeof pref>) => setPref((old) => {
    const next = { ...old, ...p };
    try { localStorage.setItem(PREF, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });

  // Live matches (also used to find a match of mine that is still running).
  useEffect(() => {
    if (!client) return;
    let alive = true;
    const load = () => client.matches().then((r) => alive && setLive(r.matches as LiveMatch[])).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [client]);

  // Resume a queue that was running before a reload; jump in when matched.
  useEffect(() => {
    if (!client) return;
    let alive = true;
    const poll = async () => {
      try {
        const q = await client.queueStatus();
        if (!alive) return;
        if (q.status === 'matched' && q.matchId && searching) { navigate(`/match/${q.matchId}`); return; }
        if (q.status === 'queued' && !searching) setSearching({ mode: pref.tab === 'practice' ? 'casual' : (pref.tab as Mode), since: Date.now() });
        if (q.status === 'idle' && searching) setSearching(null);
      } catch { /* transient */ }
    };
    poll();
    const t = setInterval(poll, searching ? 1200 : 6000);
    const clock = setInterval(() => tick((n) => n + 1), 1000);
    return () => { alive = false; clearInterval(t); clearInterval(clock); };
  }, [client, searching, navigate, pref.tab]);

  const mine = live.find((m) => m.phase !== 'ended' && m.players.some((p) => p.address.toLowerCase() === me?.address.toLowerCase()));

  const run = useCallback(async (fn: () => Promise<void>) => {
    setError(null); setBusy(true);
    try { await fn(); } catch (e) { setError((e as Error).message.replace(/^.*?→ \d+: /, '')); } finally { setBusy(false); }
  }, []);

  const startPractice = () => run(async () => {
    const id = await client!.practice({ race: pref.race, bot: botLevel, ...(botRace !== 'random' ? { botRace } : {}), ...(chosen ? { deck: chosen.cardIds } : {}) });
    navigate(`/match/${id}`);
  });

  const findMatch = () => run(async () => {
    const mode = pref.tab as Mode;
    const deckId = chosen?.id as Hex | undefined;
    const r = await client!.queue({ mode, race: pref.race, deckId });
    if (r.status === 'matched' && r.matchId) { navigate(`/match/${r.matchId}`); return; }
    setSearching({ mode, since: Date.now() });
  });

  const cancel = () => run(async () => { await client!.leaveQueue(); setSearching(null); });

  const tab = TABS.find((t) => t.id === pref.tab)!;
  const needsDeck = pref.tab === 'ranked' || pref.tab === 'human';
  // Deck choices: your registered, still-owned decks of this race (ranked-legal only for rated queues).
  const options = config?.onchain
    ? decks.filter((d) => d.race === pref.race && d.owned && (!needsDeck || d.rankedLegal))
    : [];
  const chosen = options.find((d) => d.id === pref.deckId) ?? (needsDeck ? options[0] : undefined);
  const humanBlocked = pref.tab === 'human' && me?.agent;
  const deckMissing = needsDeck && config?.onchain && !chosen;

  return (
    <div className="page play">
      <div className="play-head">
        <h1>Play</h1>
        {mine && (
          <Link className="resume" to={`/match/${mine.matchId}`}>
            <span className="dot" /> Match in progress · {mine.mode} · turn {mine.turn} <b>Resume →</b>
          </Link>
        )}
      </div>
      <LearnBanner races />

      <section aria-labelledby="race-h">
        <h2 id="race-h" className="sub">1 · Choose your race</h2>
        <div className="race-pick" role="radiogroup" aria-label="Race">
          {RACES.map((r) => (
            <button
              key={r} role="radio" aria-checked={pref.race === r} aria-label={`${RACE_INFO[r].name}: ${RACE_INFO[r].style}`}
              className={`race-opt ${pref.race === r ? 'on' : ''}`} style={{ ['--rc' as string]: `var(--${r})` }}
              onClick={() => update({ race: r })} disabled={!!searching}
            >
              <img src={spriteSvg(RACE_INFO[r].sprite)} alt="" />
              <span className="ro-text">
                <b>{RACE_INFO[r].name}</b>
                <small>{RACE_INFO[r].chain} · {RACE_INFO[r].style}</small>
                <small className="beats">Beats {raceName(BEATS[r])}</small>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="mode-h">
        <h2 id="mode-h" className="sub">2 · Choose how to play</h2>
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={pref.tab === t.id} className={pref.tab === t.id ? 'on' : ''}
              onClick={() => update({ tab: t.id })} disabled={!!searching}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="panel mode-panel">
          <p className="muted">{tab.blurb}</p>

          {pref.tab === 'practice' && (
            <div className="opts">
              <label>Opponent race
                <select value={botRace} onChange={(e) => setBotRace(e.target.value as Race | 'random')}>
                  <option value="random">Random</option>
                  {RACES.map((r) => <option key={r} value={r}>{RACE_INFO[r].name}</option>)}
                </select>
              </label>
              <label>Bot
                <select value={botLevel} onChange={(e) => setBotLevel(e.target.value as 'greedy' | 'random')}>
                  <option value="greedy">Standard</option>
                  <option value="random">Easy</option>
                </select>
              </label>
            </div>
          )}

          {config?.onchain && (
            <div className="opts">
              <label className="grow">Deck
                <select value={chosen?.id ?? ''} onChange={(e) => update({ deckId: e.target.value })} disabled={!!searching}>
                  {!needsDeck && <option value="">{raceName(pref.race)} starter list</option>}
                  {options.map((d) => (
                    <option key={d.id} value={d.id}>{deckName(d.id, d.race)} · {d.rarityPoints} pts{d.rankedLegal ? '' : ' · casual only'}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {needsDeck && config?.onchain && options.length === 0 && (
            <p className="hint warn">You have no registered, ranked-legal {raceName(pref.race)} deck. <Link to={`/decks/new?race=${pref.race}&starter=1`}>Build one</Link> (the starter list works).</p>
          )}
          {needsDeck && !config?.onchain && <p className="hint">This server runs without on-chain checks, so your race’s starter deck is used and results can’t settle.</p>}
          {humanBlocked && <p className="hint warn">Agent wallets can’t join the Human queue. Play Ranked instead.</p>}
          {error && <div className="alert err" role="alert"><span>{error}</span><button onClick={() => setError(null)} aria-label="Dismiss">✕</button></div>}

          {searching ? (
            <div className="searching" role="status">
              <span className="radar" aria-hidden />
              <div>
                <b>Searching for an opponent…</b>
                <div className="muted">{searching.mode} · {raceName(pref.race)} · {Math.floor((Date.now() - searching.since) / 1000)} s</div>
              </div>
              <button className="btn" onClick={cancel} disabled={busy}>Cancel</button>
            </div>
          ) : (
            <button
              className="btn btn-primary btn-lg"
              disabled={busy || !!humanBlocked || !!deckMissing || !!mine}
              onClick={pref.tab === 'practice' ? startPractice : findMatch}
            >
              {busy ? <span className="spinner" /> : null}
              {pref.tab === 'practice' ? `Play ${raceName(pref.race)} vs bot` : `Find ${tab.label.toLowerCase()} match`}
            </button>
          )}
          {mine && !searching && <p className="hint">Finish or concede your current match first.</p>}
        </div>
      </section>

      <section aria-labelledby="live-h">
        <h2 id="live-h" className="sub">Live &amp; recent matches</h2>
        {live.length === 0 ? <p className="muted">No matches yet. Start one!</p> : (
          <div className="live-list">
            {live.slice(0, 12).map((m) => (
              <div className="live-row" key={m.matchId}>
                <div className="lr-players">
                  {m.players.map((p, i) => (
                    <span key={i} className="lr-p" style={{ ['--rc' as string]: `var(--${p.race})` }}>
                      <img src={spriteSvg(RACE_INFO[p.race].sprite)} alt="" />
                      <span>{raceName(p.race)}</span>
                      {p.agent && <span className="badge agent">Agent</span>}
                      <span className="mono muted">{shortAddr(p.address)}</span>
                    </span>
                  )).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, <span key={`vs${i}`} className="vs">vs</span>, el] : [el]), [])}
                </div>
                <span className={`badge ${m.phase === 'active' ? 'live' : ''}`}>{m.phase === 'active' ? `Live · turn ${m.turn}` : m.phase}</span>
                <span className="muted lr-mode">{m.mode}</span>
                <Link className="btn btn-ghost" to={`/match/${m.matchId}`}>{m.phase === 'active' ? 'Watch' : 'View'}</Link>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
