import { BEATS, RACES, type Race } from '@forkfall/engine';
import type { Mode } from '@forkfall/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { Address, Hex } from 'viem';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useMyDecks } from '../chain/useMyDecks.ts';
import { LearnBanner } from '../components/LearnBanner.tsx';
import { PassPanel } from '../components/PassPanel.tsx';
import { QuestPanel } from '../components/QuestPanel.tsx';
import { ChallengeWaiting, IncomingChallenges, loadWaiting, saveWaiting } from '../components/Challenges.tsx';
import { isAddress } from 'viem';
import { deckName } from '../lib/deckNames.ts';
import { RACE_INFO, raceName } from '../game/meta.ts';
import { spriteSvg } from '../lib/art.ts';
import { shortAddr } from '../lib/format.ts';
import { useLiveTopic } from '../lib/live.ts';

type Tab = 'practice' | Mode | 'friend';
const TABS: { id: Tab; label: string; blurb: string }[] = [
  { id: 'practice', label: 'Practice', blurb: 'Play the house bot. Nothing at stake, starts instantly.' },
  { id: 'casual', label: 'Casual', blurb: 'Humans and agents, no rating. Uses your race’s starter deck.' },
  { id: 'ranked', label: 'Ranked', blurb: 'Season Elo for humans and agents together. Needs a registered, ranked-legal deck.' },
  { id: 'friend', label: 'Friend', blurb: 'Send a link to a friend, human or agent: a casual match starts the moment they accept. Optionally lock it to one wallet.' },
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
  const [waiting, setWaiting] = useState<string | null>(loadWaiting);
  const [friend, setFriend] = useState('');
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
  }, [wantDeck, decks, setParams]);

  const update = (p: Partial<typeof pref>) => setPref((old) => {
    const next = { ...old, ...p };
    try { localStorage.setItem(PREF, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });

  // Live matches (also used to find a match of mine that is still running). The referee pushes a 'lobby'
  // notice when the list changes; the interval is only a safety net while the socket is up.
  const loadLive = useCallback(() => {
    client?.matches().then((r) => setLive(r.matches as LiveMatch[])).catch(() => {});
  }, [client]);
  const lobbyUp = useLiveTopic(client ? 'lobby' : null, loadLive);
  useEffect(() => {
    if (!client) return;
    loadLive();
    const t = setInterval(loadLive, lobbyUp ? 30_000 : 5000);
    return () => clearInterval(t);
  }, [client, loadLive, lobbyUp]);

  // Resume a queue that was running before a reload; jump in when matched. A 'me' notice of kind 'match'
  // arrives the moment the queue pairs us, so the poll can stay slow while the socket is up.
  const searchingRef = useRef(searching);
  searchingRef.current = searching;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const pollQueue = useCallback(async () => {
    if (!client) return;
    try {
      const q = await client.queueStatus();
      if (!mounted.current) return;
      const s = searchingRef.current;
      if (q.status === 'matched' && q.matchId && s) { navigate(`/match/${q.matchId}`); return; }
      if (q.status === 'queued' && !s) setSearching({ mode: pref.tab === 'practice' || pref.tab === 'friend' ? 'casual' : (pref.tab as Mode), since: Date.now() });
      if (q.status === 'idle' && s) setSearching(null);
    } catch { /* transient */ }
  }, [client, navigate, pref.tab]);
  const meUp = useLiveTopic(client ? 'me' : null, (e) => {
    if (e.kind === 'match' || e.kind === 'reconnect') pollQueue();
    if (e.kind === 'match') loadLive();
  });
  useEffect(() => {
    if (!client) return;
    pollQueue();
    const t = setInterval(pollQueue, searching ? (meUp ? 10_000 : 1200) : (meUp ? 60_000 : 6000));
    const clock = setInterval(() => tick((n) => n + 1), 1000);
    return () => { clearInterval(t); clearInterval(clock); };
  }, [client, searching, pollQueue, meUp]);

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

  const challengeFriend = () => run(async () => {
    const to = friend.trim();
    if (to && !isAddress(to)) throw new Error('That isn’t a wallet address (0x…). Leave it empty for a link anyone can use.');
    const c = await client!.createChallenge({ race: pref.race, ...(to ? { to: to as Address } : {}), ...(chosen ? { deck: chosen.cardIds } : {}) });
    saveWaiting(c.code); setWaiting(c.code);
  });

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
      <Link to="/sealed" className="panel sealed-banner">
        <span className="sb-ico" aria-hidden>🎴</span>
        <span><b>Sealed</b> <span className="muted">Open 6 packs, build a deck from them, play to 7 wins. One free run a day, prizes up to 2 packs.</span></span>
        <span className="btn btn-sm">Play Sealed</span>
      </Link>
      <IncomingChallenges />

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

          {pref.tab === 'friend' && !waiting && (
            <div className="opts">
              <label className="grow">Only this wallet (optional)
                <input value={friend} onChange={(e) => setFriend(e.target.value)} placeholder="0x… or leave empty for a link anyone can use" spellCheck={false} />
              </label>
            </div>
          )}

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

          {pref.tab === 'friend' && waiting ? (
            <ChallengeWaiting code={waiting} onDone={() => setWaiting(null)} />
          ) : pref.tab === 'friend' ? (
            <button className="btn btn-primary btn-lg" disabled={busy || !!mine} onClick={challengeFriend}>
              {busy ? <span className="spinner" /> : null} Create challenge link
            </button>
          ) : searching ? (
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

      <PassPanel />
      <QuestPanel />

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
