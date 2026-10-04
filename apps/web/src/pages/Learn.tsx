import {
  advanceLesson, applyAction, card, createLesson, eventsFor, legalActions, lessonById, LESSONS, PREDICTION_LABELS, PREDICTION_TIERS,
  tutorialBotMove, viewFor,
  type Action, type GameEvent, type GameState, type Lesson, type LessonId, type PredictionCondition, type Race, type UnitState,
} from '@forkfall/engine';
import type { MatchSnapshot } from '@forkfall/sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { GameCard } from '../components/GameCard.tsx';
import { FxLayer } from '../game/FxLayer.tsx';
import { RACE_COLOR, RACE_INFO, raceName } from '../game/meta.ts';
import { spriteSvg } from '../lib/art.ts';
import { lessonsDoneLocally, markLessonDone } from '../lib/cosmetics.ts';
import { Dialog, Log, Preview, Side } from './Match.tsx';

type PlayAction = Extract<Action, { type: 'play' }>;
const BOT_STEP_MS = 750;

/** /learn: pick a lesson. /learn/<lesson>: play it. Entirely in the browser: no wallet, server or chain. */
export function Learn() {
  const id = useLocation().pathname.split('/')[2];
  const lesson = id ? lessonById(id) : undefined;
  return lesson ? <LessonMatch key={lesson.id} lesson={lesson} /> : <LessonPicker />;
}

const LESSON_SPRITE: Record<LessonId, number> = { basics: 2, prophets: 9, brokers: 19, degens: 25 };

function LessonPicker() {
  const done = lessonsDoneLocally();
  const basicsDone = done.includes('basics');
  return (
    <div className="page lessons">
      <h1>Learn to play</h1>
      <p className="lead">Short guided matches against a gentle bot, a few minutes each. No wallet needed. Start with the basics, then learn each race’s trick.</p>
      <div className="lesson-grid">
        {LESSONS.map((l, i) => {
          const isDone = done.includes(l.id);
          return (
            <Link key={l.id} to={`/learn/${l.id}`} className={`panel lesson-card ${isDone ? 'done' : ''}`} style={{ ['--rc' as string]: RACE_COLOR[l.race] }}>
              <img src={spriteSvg(LESSON_SPRITE[l.id])} alt="" />
              <div>
                <span className="lesson-n">{i === 0 ? 'Start here' : `Race lesson ${i}`}</span>
                <h2>{l.title}</h2>
                <p className="muted">{l.blurb}</p>
                <span className="small">You play {RACE_INFO[l.race].name} · {l.steps.length} steps</span>
              </div>
              <span className={`lesson-state ${isDone ? 'ok' : ''}`}>{isDone ? '✓ Done' : i > 0 && !basicsDone ? 'After the basics' : 'Play →'}</span>
            </Link>
          );
        })}
      </div>
      <p className="muted small">🎓 The basics unlock the <b>Graduate</b> title; all four lessons unlock <b>Scholar</b>. Equip titles on your Profile.</p>
    </div>
  );
}

/**
 * One lesson: the real rules engine and match effects against a scripted bot. A coach points at what to do
 * next; each step completes when you actually do it, and "Show me" does it for you.
 */
function LessonMatch({ lesson }: { lesson: Lesson }) {
  const start = useMemo(() => createLesson(lesson.id), [lesson.id]);
  const [g, setG] = useState<GameState>(start.state);
  const [events, setEvents] = useState<GameEvent[]>(() => eventsFor(start.events, 0));
  const all = useRef<GameEvent[]>([]);
  const since = useRef<GameEvent[]>([]);
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<{ kind: 'hand' | 'unit'; uid: number; ape?: boolean } | null>(null);
  const [modal, setModal] = useState<{ kind: 'ape' | 'prediction'; uid: number; ape?: boolean } | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const arena = useRef<HTMLDivElement>(null);
  const steps = lesson.steps;
  const s = steps[step];

  const myTurn = g.status === 'active' && g.active === 0;
  const legal = useMemo(() => (myTurn ? legalActions(g, 0) : []), [g, myTurn]);

  const act = (seat: 0 | 1, a: Action) => {
    if (seat === 0) {
      const why = s?.forbid?.(g, a);
      if (why) { setHint(why); setSelected(null); setModal(null); return; }
    }
    try {
      const r = applyAction(g, seat, a);
      all.current.push(...r.events);
      since.current.push(...r.events);
      setEvents((e) => [...e, ...eventsFor(r.events, 0)]);
      setG(r.state);
      setSelected(null); setModal(null); setHint(null);
      const next = advanceLesson(steps, step, r.state, since.current, all.current);
      if (next !== step) { setStep(next); since.current = []; }
    } catch (e) { setHint((e as Error).message); }
  };

  // The bot takes its turn one action at a time so the effects can play.
  useEffect(() => {
    if (g.status !== 'active' || g.active !== 1) return;
    const t = setTimeout(() => act(1, tutorialBotMove(g)), BOT_STEP_MS);
    return () => clearTimeout(t);
  });

  useEffect(() => { if (g.status === 'ended' && g.winner === 0) markLessonDone(lesson.id); }, [g.status, g.winner, lesson.id]);

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
  }), [g, legal]);

  const sel = selected;
  const selActs = sel ? legal.filter((a) => (sel.kind === 'hand' ? a.type === 'play' && a.uid === sel.uid && !!a.ape === !!sel.ape : a.type === 'attack' && a.attacker === sel.uid)) : [];
  const targets = new Set(selActs.map((a) => (a.type === 'play' || a.type === 'attack' ? a.target : undefined)).filter((t) => t !== undefined));
  const ready = new Set(legal.filter((a) => a.type === 'attack').map((a) => (a as { attacker: number }).attacker));
  const playable = new Set(legal.filter((a) => a.type === 'play').map((a) => (a as PlayAction).uid));

  const clickHand = (uid: number) => {
    if (!myTurn) return setHint('Wait for your turn.');
    const plays = legal.filter((a): a is PlayAction => a.type === 'play' && a.uid === uid);
    if (!plays.length) return setHint('Not enough Gas for that card yet.');
    const hasApe = plays.some((a) => a.ape);
    const hasNormal = plays.some((a) => !a.ape);
    if (hasApe && hasNormal) return setModal({ kind: 'ape', uid });
    continuePlay(uid, hasApe && !hasNormal);
  };
  const continuePlay = (uid: number, ape: boolean) => {
    const plays = legal.filter((a): a is PlayAction => a.type === 'play' && a.uid === uid && !!a.ape === ape);
    if (plays.some((a) => a.condition)) return setModal({ kind: 'prediction', uid, ape });
    setModal(null);
    if (plays.every((a) => a.target !== undefined)) {
      setSelected({ kind: 'hand', uid, ape });
      setHint(`Now click a target for ${card(g.players[0].hand.find((h) => h.uid === uid)!.cardId).name}.`);
      return;
    }
    act(0, plays.find((a) => a.target === undefined)!);
  };
  const clickUnit = (uid: number, owner: 0 | 1) => {
    if (sel && targets.has(uid)) {
      const a = selActs.find((x) => (x.type === 'play' || x.type === 'attack') && x.target === uid);
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
  const showMe = () => {
    const a = s?.auto?.(g, legal.filter((x) => !s.forbid?.(g, x)));
    if (a) act(0, a); else setHint('Nothing to do for this step right now: end your turn.');
  };

  const restart = () => {
    setG(start.state); setEvents(eventsFor(start.events, 0)); all.current = []; since.current = [];
    setStep(0); setSelected(null); setModal(null); setHint(null);
  };
  const races: [Race, Race] = [g.players[0].race, g.players[1].race];
  const v = snap.view!;
  const swarmBonus = (side: 0 | 1, u: UnitState) =>
    u.keywords.includes('swarm') ? v.players[side].board.filter((x) => x.uid !== u.uid && x.keywords.includes('swarm')).length : 0;
  const nextLesson = LESSONS[LESSONS.findIndex((l) => l.id === lesson.id) + 1];
  const cardName = (uid: number) => card(v.hand.find((h) => h.uid === uid)?.cardId ?? 0).name;
  const costOf = (uid: number) => Math.max(0, card(v.hand.find((h) => h.uid === uid)?.cardId ?? 0).cost - v.players[0].discount);

  return (
    <div className="match learn">
      <FxLayer events={events} seat={0} arena={arena} races={[raceName(races[0]), raceName(races[1])]} />
      <div className="arena" ref={arena} onClick={() => { if (sel) { setSelected(null); setHint(null); } }}>
        <Side s={snap} side={1} isMe={false} hits={new Set()} onTreasury={clickTreasury} treasuryTarget={sel?.kind === 'unit' && targets.has('treasury')}>
          <div className="lane opp-lane" aria-label="Bot board">
            {v.players[1].board.length === 0 && <span className="lane-empty">No units</span>}
            {v.players[1].board.map((u) => (
              <GameCard key={u.uid} size="board" cardId={u.cardId} unit={u} bonusAttack={swarmBonus(1, u)} targetable={targets.has(u.uid)}
                onClick={targets.has(u.uid) ? () => clickUnit(u.uid, 1) : undefined} onHover={setPreview} />
            ))}
          </div>
        </Side>
        <div className="turnbar" onClick={(e) => e.stopPropagation()}>
          <div className="tb-left">
            <span className={`turn-pill ${myTurn ? 'mine' : ''}`}>{g.status === 'ended' ? 'Match over' : myTurn ? 'Your turn' : 'Bot’s turn'}</span>
            <span className="muted small">Turn {g.turn} · {lesson.title}</span>
          </div>
          <span className="hint-inline" role="status">{hint ?? ''}</span>
          <div className="tb-right">
            <Link className="btn btn-ghost" to="/learn">All lessons</Link>
            {myTurn && <button className="btn btn-primary end-turn" onClick={() => act(0, { type: 'endTurn' })}>End turn</button>}
          </div>
        </div>
        <Side s={snap} side={0} isMe hits={new Set()}>
          <div className="lane me-lane" aria-label="Your board">
            {v.players[0].board.length === 0 && <span className="lane-empty">Play units from your hand</span>}
            {v.players[0].board.map((u) => (
              <GameCard key={u.uid} size="board" cardId={u.cardId} unit={u} bonusAttack={swarmBonus(0, u)} ready={ready.has(u.uid)}
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
            <div className="coach-top"><span className="coach-step">Step {step + 1} of {steps.length}</span></div>
            <h2>{s.title}</h2>
            <p>{s.body}</p>
            {s.next
              ? <button className="btn btn-primary" onClick={() => { setStep(step + 1); since.current = []; }}>Next</button>
              : s.auto && myTurn && <button className="btn btn-ghost btn-sm show-me" onClick={showMe}>Show me</button>}
          </div>
        )}
        <Preview cardId={preview} />
        <Log events={events} seat={0} races={races} />
      </aside>

      {modal?.kind === 'ape' && (
        <Dialog title="Ape in?" onClose={() => setModal(null)}>
          <p className="muted">Ape plays {cardName(modal.uid)} for 2 less Gas, with a random downside: lose 2 Treasury, discard a random card, or the unit enters with −1 health.</p>
          <div className="choice-list">
            <button className="choice" onClick={() => continuePlay(modal.uid, false)}><b>Play normally</b><span>{costOf(modal.uid)} Gas</span></button>
            <button className="choice ape" onClick={() => continuePlay(modal.uid, true)}><b>Ape in</b><span>{Math.max(0, costOf(modal.uid) - 2)} Gas · random downside</span></button>
          </div>
        </Dialog>
      )}
      {modal?.kind === 'prediction' && (
        <Dialog title="Foresee" onClose={() => setModal(null)}>
          <p className="muted">What will the bot do on its next turn? Your call stays face-down until it resolves. Bolder calls pay more; wrong calls backfire.</p>
          <div className="choice-list">
            {legal.filter((a): a is PlayAction => a.type === 'play' && a.uid === modal.uid && !!a.ape === !!modal.ape && !!a.condition).map((a) => (
              <button key={a.condition} className="choice" onClick={() => act(0, a)}>
                <b>{PREDICTION_LABELS[a.condition as PredictionCondition]}</b>
                <span className="tier">{'◆'.repeat(PREDICTION_TIERS[a.condition as PredictionCondition])} Odds tier {PREDICTION_TIERS[a.condition as PredictionCondition]}</span>
              </button>
            ))}
          </div>
        </Dialog>
      )}

      {g.status === 'ended' && (
        <div className="modal-bg result-bg">
          <div className={`modal result ${g.winner === 0 ? 'win' : 'loss'}`} role="dialog" aria-modal="true" aria-label="Lesson complete">
            <h2 className="result-title">{g.winner === 0 ? (lesson.id === 'basics' ? 'You’re ready!' : 'Lesson complete!') : 'So close'}</h2>
            {g.winner === 0 ? (
              <>
                <p className="muted">{lesson.learned}</p>
                {lesson.id === 'basics' && <p className="unlock">🎓 Unlocked: the <b>Graduate</b> title. Equip it on your Profile.</p>}
                {LESSONS.every((l) => l.id === lesson.id || lessonsDoneLocally().includes(l.id)) && <p className="unlock">📜 Every lesson done: the <b>Scholar</b> title is yours. Equip it on your Profile.</p>}
              </>
            ) : <p className="muted">The bot got you this time. Try again, or press “Show me” when you’re not sure.</p>}
            <div className="row-end">
              <button className="btn btn-ghost" onClick={restart}>{g.winner === 0 ? 'Replay' : 'Try again'}</button>
              {g.winner === 0 && nextLesson
                ? <Link className="btn btn-primary" to={`/learn/${nextLesson.id}`}>Next: {nextLesson.title}</Link>
                : <Link className="btn" to="/learn">All lessons</Link>}
              <Link className={`btn ${g.winner === 0 && nextLesson ? '' : 'btn-primary'}`} to="/play">Play a practice match</Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
