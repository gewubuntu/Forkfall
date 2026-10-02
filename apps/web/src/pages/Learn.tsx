import {
  advanceTutorial, applyAction, card, createTutorial, eventsFor, legalActions, tutorialBotMove, TUTORIAL_STEPS, viewFor,
  type Action, type GameEvent, type GameState, type Race,
} from '@forkfall/engine';
import type { MatchSnapshot } from '@forkfall/sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { GameCard } from '../components/GameCard.tsx';
import { FxLayer } from '../game/FxLayer.tsx';
import { raceName } from '../game/meta.ts';
import { markTutorialDone } from '../lib/cosmetics.ts';
import { Log, Preview, Side } from './Match.tsx';

type PlayAction = Extract<Action, { type: 'play' }>;
const BOT_STEP_MS = 750;

/**
 * Learn to play: a guided first match against a gentle scripted bot, entirely in the browser (no wallet, no
 * server, nothing on-chain), with the same rules engine and match effects as real games. A coach points at
 * what to do next; each lesson completes when you actually do it.
 */
export function Learn() {
  const [g, setG] = useState<GameState>(() => createTutorial().state);
  const [events, setEvents] = useState<GameEvent[]>(() => eventsFor(createTutorial().events, 0));
  const all = useRef<GameEvent[]>([]);
  const since = useRef<GameEvent[]>([]);
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<{ kind: 'hand' | 'unit'; uid: number } | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const arena = useRef<HTMLDivElement>(null);

  const myTurn = g.status === 'active' && g.active === 0;
  const legal = myTurn ? legalActions(g, 0) : [];

  const act = (seat: 0 | 1, a: Action) => {
    try {
      const r = applyAction(g, seat, a);
      all.current.push(...r.events);
      since.current.push(...r.events);
      setEvents((e) => [...e, ...eventsFor(r.events, 0)]);
      setG(r.state);
      setSelected(null); setHint(null);
      const next = advanceTutorial(step, r.state, since.current, all.current);
      if (next !== step) { setStep(next); since.current = []; }
    } catch (e) { setHint((e as Error).message); }
  };

  // The bot takes its turn one action at a time so the effects can play.
  useEffect(() => {
    if (g.status !== 'active' || g.active !== 1) return;
    const t = setTimeout(() => act(1, tutorialBotMove(g)), BOT_STEP_MS);
    return () => clearTimeout(t);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (g.status === 'ended' && g.winner === 0) markTutorialDone(); }, [g.status, g.winner]);

  const s = TUTORIAL_STEPS[step];
  // Point at the thing to do: a glowing outline on the step's target.
  useEffect(() => {
    if (!s?.target || g.status !== 'active') return;
    const el = document.querySelector(s.target);
    el?.classList.add('tut-glow');
    return () => el?.classList.remove('tut-glow');
  }, [s?.target, g.status, g.turn, g.active]);

  const snap = useMemo<MatchSnapshot>(() => ({
    matchId: '0x' + '0'.repeat(64) as `0x${string}`, phase: g.status === 'ended' ? 'ended' : 'active', mode: 'casual', seat: 0,
    players: g.players.map((p, i) => ({ address: p.address, race: p.race, agent: i === 1 })),
    view: viewFor(g, 0), legalActions: legal, seq: 0, head: '0x' as `0x${string}`, clock: null, eventCount: 0,
  }), [g]); // eslint-disable-line react-hooks/exhaustive-deps

  const sel = selected;
  const selActs = sel ? legal.filter((a) => (sel.kind === 'hand' ? a.type === 'play' && a.uid === sel.uid : a.type === 'attack' && a.attacker === sel.uid)) : [];
  const targets = new Set(selActs.map((a) => (a.type === 'play' || a.type === 'attack' ? a.target : undefined)).filter((t) => t !== undefined));
  const ready = new Set(legal.filter((a) => a.type === 'attack').map((a) => (a as { attacker: number }).attacker));
  const playable = new Set(legal.filter((a) => a.type === 'play').map((a) => (a as PlayAction).uid));

  const clickHand = (uid: number) => {
    if (!myTurn) return setHint('Wait for your turn.');
    const plays = legal.filter((a): a is PlayAction => a.type === 'play' && a.uid === uid && !a.ape);
    if (!plays.length) return setHint('Not enough Gas for that card yet.');
    if (plays.every((a) => a.target !== undefined)) { setSelected({ kind: 'hand', uid }); setHint('Now click a target.'); return; }
    act(0, plays.find((a) => a.target === undefined)!);
  };
  const clickUnit = (uid: number, owner: 0 | 1) => {
    if (sel && targets.has(uid)) {
      const a = legal.find((x) => (sel.kind === 'hand' ? x.type === 'play' && x.uid === sel.uid && x.target === uid : x.type === 'attack' && x.attacker === sel.uid && x.target === uid));
      if (a) return act(0, a);
    }
    if (owner === 0 && ready.has(uid)) { setSelected({ kind: 'unit', uid }); setHint('Now click a target: an enemy unit or the enemy Treasury.'); return; }
    if (owner === 0 && myTurn) setHint('That unit can’t attack right now (new this turn, or already attacked).');
  };
  const clickTreasury = () => {
    if (sel?.kind !== 'unit' || !targets.has('treasury')) return;
    const a = legal.find((x) => x.type === 'attack' && x.attacker === sel.uid && x.target === 'treasury');
    if (a) act(0, a);
  };

  const restart = () => { const t = createTutorial(); setG(t.state); setEvents(eventsFor(t.events, 0)); all.current = []; since.current = []; setStep(0); setSelected(null); };
  const races: [Race, Race] = [g.players[0].race, g.players[1].race];
  const v = snap.view!;

  return (
    <div className="match learn">
      <FxLayer events={events} seat={0} arena={arena} races={[raceName(races[0]), raceName(races[1])]} />
      <div className="arena" ref={arena} onClick={() => { if (sel) { setSelected(null); setHint(null); } }}>
        <Side s={snap} side={1} isMe={false} hits={new Set()} onTreasury={clickTreasury} treasuryTarget={sel?.kind === 'unit' && targets.has('treasury')}>
          <div className="lane opp-lane" aria-label="Bot board">
            {v.players[1].board.length === 0 && <span className="lane-empty">No units</span>}
            {v.players[1].board.map((u) => (
              <GameCard key={u.uid} size="board" cardId={u.cardId} unit={u} targetable={targets.has(u.uid)}
                onClick={targets.has(u.uid) ? () => clickUnit(u.uid, 1) : undefined} onHover={setPreview} />
            ))}
          </div>
        </Side>
        <div className="turnbar" onClick={(e) => e.stopPropagation()}>
          <div className="tb-left">
            <span className={`turn-pill ${myTurn ? 'mine' : ''}`}>{g.status === 'ended' ? 'Match over' : myTurn ? 'Your turn' : 'Bot’s turn'}</span>
            <span className="muted small">Turn {g.turn} · tutorial</span>
          </div>
          <span className="hint-inline" role="status">{hint ?? ''}</span>
          <div className="tb-right">
            <Link className="btn btn-ghost" to="/">Skip tutorial</Link>
            {myTurn && <button className="btn btn-primary end-turn" onClick={() => act(0, { type: 'endTurn' })}>End turn</button>}
          </div>
        </div>
        <Side s={snap} side={0} isMe hits={new Set()}>
          <div className="lane me-lane" aria-label="Your board">
            {v.players[0].board.length === 0 && <span className="lane-empty">Play units from your hand</span>}
            {v.players[0].board.map((u) => (
              <GameCard key={u.uid} size="board" cardId={u.cardId} unit={u} ready={ready.has(u.uid)}
                selected={sel?.kind === 'unit' && sel.uid === u.uid} targetable={targets.has(u.uid)}
                onClick={() => clickUnit(u.uid, 0)} onHover={setPreview} />
            ))}
          </div>
        </Side>
        <div className="hand tut-hand" aria-label="Your hand">
          {v.hand.map((h) => (
            <GameCard key={h.uid} cardId={h.cardId} cost={Math.max(0, card(h.cardId).cost - v.players[0].discount)}
              playable={playable.has(h.uid)} dimmed={myTurn && !playable.has(h.uid)} selected={sel?.kind === 'hand' && sel.uid === h.uid}
              onClick={() => clickHand(h.uid)} onHover={setPreview} />
          ))}
        </div>
      </div>

      <aside className="sidebar">
        {s && g.status === 'active' && (
          <div className="coach" role="region" aria-label="Coach" aria-live="polite">
            <div className="coach-top"><span className="coach-step">Lesson {step + 1} of {TUTORIAL_STEPS.length}</span></div>
            <h2>{s.title}</h2>
            <p>{s.body}</p>
            {s.next && <button className="btn btn-primary" onClick={() => { setStep(step + 1); since.current = []; }}>Next</button>}
          </div>
        )}
        <Preview cardId={preview} />
        <Log events={events} seat={0} races={races} />
      </aside>

      {g.status === 'ended' && (
        <div className="modal-bg result-bg">
          <div className={`modal result ${g.winner === 0 ? 'win' : 'loss'}`} role="dialog" aria-modal="true" aria-label="Tutorial complete">
            <h2 className="result-title">{g.winner === 0 ? 'You’re ready!' : 'So close'}</h2>
            {g.winner === 0 ? (
              <>
                <p className="muted">You know the basics: Gas, units, attacking, Guard, Rush and the Agents’ Automate. Each race has its own tricks to discover.</p>
                <p className="unlock">🎓 Unlocked: the <b>Graduate</b> title. Equip it on your Profile.</p>
              </>
            ) : <p className="muted">The bot got you this time. Try again: play units early and break through the Guard.</p>}
            <div className="row-end">
              <button className="btn btn-ghost" onClick={restart}>{g.winner === 0 ? 'Replay tutorial' : 'Try again'}</button>
              <Link className="btn" to="/collection">Claim free starter decks</Link>
              <Link className="btn btn-primary" to="/play">Play a practice match</Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
