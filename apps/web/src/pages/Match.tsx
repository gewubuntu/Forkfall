import {
  cosmetic,
  card, PREDICTION_LABELS, PREDICTION_TIERS,
  type Action, type GameEvent, type PredictionCondition, type Race, type UnitState,
} from '@forkfall/engine';
import { matchSettlementAbi, type MatchSnapshot } from '@forkfall/sdk';
import { useReadContract } from 'wagmi';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { Hex } from 'viem';
import { useAuth } from '../auth/AuthProvider.tsx';
import { friendlyError } from '../chain/errors.ts';
import { useHub } from '../chain/useHub.ts';
import { useSeasonStats, useSettled, useSettleMatch, type SettledQuery } from '../chain/useSettlement.ts';
import { CardBack, GameCard } from '../components/GameCard.tsx';
import { CardZoom } from '../components/CardZoom.tsx';
import { PassPanel } from '../components/PassPanel.tsx';
import { QuestPanel } from '../components/QuestPanel.tsx';
import { ChallengeWaiting } from '../components/Challenges.tsx';
import { useQueryClient } from '@tanstack/react-query';
import { describeEvent, KEYWORD_HELP, KEYWORD_LABEL, RACE_INFO, raceName } from '../game/meta.ts';
import { FxLayer } from '../game/FxLayer.tsx';
import { useBoardGestures, type DragSource, type DropTarget } from '../game/gestures.ts';
import { summarize, useCountUp } from '../game/summary.ts';
import { useMatch } from '../game/useMatch.ts';
import { isMuted, setMuted } from '../lib/sfx.ts';
import { avatarSvg, spriteSvg } from '../lib/art.ts';
import { emblem } from '../lib/cosmetics.ts';
import { inTime, shortAddr } from '../lib/format.ts';
import { useLiveTopic } from '../lib/live.ts';
import { COMPACT_QUERY, useMedia, useTouch } from '../lib/useMedia.ts';
import { useReturnedWhilePending } from '../lib/useWalletReturn.ts';

type PlayAction = Extract<Action, { type: 'play' }>;
type Selection = { kind: 'hand' | 'unit'; uid: number } | null;
type Modal = { kind: 'ape' | 'prediction'; uid: number; ape?: boolean } | { kind: 'concede' } | null;

/** Keyed by match id, so moving from one match to the next (a rematch) starts from fresh state. */
export function Match() {
  const { id } = useParams();
  return <MatchView key={id} />;
}

function MatchView() {
  const { id } = useParams();
  const matchId = id as Hex;
  const { client } = useAuth();
  const m = useMatch(client, matchId);
  const [selected, setSelected] = useState<Selection>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const skew = useRef(0);
  /** Whether the pending play of a hand card uses Ape (chosen in the Ape dialog). */
  const apeChoice = useRef(new Map<number, boolean>());
  const [resultOpen, setResultOpen] = useState(true);
  const [zoom, setZoom] = useState<number | null>(null);
  const arenaRef = useRef<HTMLDivElement>(null);
  const touch = useTouch();
  const compact = useMedia(COMPACT_QUERY);
  const [logOpen, setLogOpen] = useState(false);
  /** Drag handlers for this render's board (the gesture hook is set up once, before the loading screens return). */
  const drag = useRef<{ canDrag: (s: DragSource) => boolean; start: (s: DragSource) => void; drop: (s: DragSource, t: DropTarget) => void }>(null);
  useBoardGestures(arenaRef, {
    onZoom: setZoom,
    canDrag: (src) => drag.current?.canDrag(src) ?? false,
    onDragStart: (src) => drag.current?.start(src),
    onDrop: (src, t) => drag.current?.drop(src, t),
  });

  const s = m.snap;
  if (s?.now) skew.current = s.now - Date.now();

  // Clear stale selections whenever the turn or legal moves change.
  const legalKey = s ? `${s.seq}` : '';
  useEffect(() => { setSelected(null); setHint(null); }, [legalKey]);

  const send = useCallback(async (a: Action) => {
    setSelected(null); setHint(null); setModal(null);
    await m.send(a);
  }, [m]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, select, textarea')) return;
      if (e.key === 'Escape') { setSelected(null); setModal(null); setHint(null); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (m.notFound) {
    return <div className="page"><div className="panel empty"><h2>Match not found</h2><p>It may have been cancelled because a player didn’t reveal in time.</p><Link className="btn" to="/play">Back to Play</Link></div></div>;
  }
  if (!s) return <div className="gate"><span className="spinner" aria-label="Loading match" /></div>;
  if (s.phase === 'cancelled') {
    return (
      <div className="page"><div className="panel empty">
        <h2>Match cancelled</h2>
        <p>{s.seat === null ? 'A player' : 'Your opponent'} didn’t connect in time, so the match was called off before it started. Nothing was played or recorded.</p>
        <Link className="btn btn-primary" to="/play">Back to Play</Link>
      </div></div>
    );
  }
  if (!s.view) {
    return (
      <div className="gate"><div className="card" role="status">
        <h2>Shuffling…</h2>
        <p className="lead">Both players reveal their secret seed so neither can control the shuffle. This takes a second.</p>
        <span className="spinner" />
      </div></div>
    );
  }

  const v = s.view;
  const seat = s.seat;
  const me = (seat ?? 0) as 0 | 1;
  const op = (me === 0 ? 1 : 0) as 0 | 1;
  const races: [Race, Race] = [v.players[0].race, v.players[1].race];
  const myTurn = s.phase === 'active' && seat !== null && v.active === seat;
  const legal = s.legalActions;
  const sel = selected;

  const selActs = sel
    ? legal.filter((a) => (sel.kind === 'hand' ? a.type === 'play' && a.uid === sel.uid && !!a.ape === pendingApe(sel.uid) : a.type === 'attack' && a.attacker === sel.uid))
    : [];
  const targets = new Set(selActs.map((a) => (a.type === 'play' || a.type === 'attack' ? a.target : undefined)).filter((t) => t !== undefined));
  const readyUnits = new Set(myTurn ? legal.filter((a) => a.type === 'attack').map((a) => (a as { attacker: number }).attacker) : []);
  const playableHand = new Set(myTurn ? legal.filter((a) => a.type === 'play').map((a) => (a as PlayAction).uid) : []);

  function pendingApe(uid: number) { return apeChoice.current.get(uid) ?? false; }

  function clickHand(uid: number) {
    if (!myTurn) { setHint('Wait for your turn.'); return; }
    const plays = legal.filter((a): a is PlayAction => a.type === 'play' && a.uid === uid);
    if (!plays.length) { setHint('Not enough Gas, no space, or no valid target.'); return; }
    const armed = sel?.kind === 'hand' && sel.uid === uid;
    // Touch: the first tap only picks the card up (details + targets show); a second tap or Play commits it.
    if (touch && !armed) { setSelected({ kind: 'hand', uid }); setHint(null); return; }
    if (armed && !touch) { setSelected(null); setHint(null); return; }
    commitHand(uid);
  }

  function commitHand(uid: number) {
    const plays = legal.filter((a): a is PlayAction => a.type === 'play' && a.uid === uid);
    if (!plays.length) { setHint('Not enough Gas, no space, or no valid target.'); return; }
    const hasApe = plays.some((a) => a.ape);
    const hasNormal = plays.some((a) => !a.ape);
    if (hasApe && hasNormal) { setModal({ kind: 'ape', uid }); return; }
    continuePlay(uid, hasApe && !hasNormal);
  }

  function continuePlay(uid: number, ape: boolean) {
    apeChoice.current.set(uid, ape);
    const plays = legal.filter((a): a is PlayAction => a.type === 'play' && a.uid === uid && !!a.ape === ape);
    if (plays.some((a) => a.condition)) { setModal({ kind: 'prediction', uid, ape }); return; }
    const targeted = plays.filter((a) => a.target !== undefined);
    if (targeted.length && !plays.some((a) => a.target === undefined)) {
      setModal(null);
      setSelected({ kind: 'hand', uid });
      const c = card(v.hand.find((h) => h.uid === uid)!.cardId);
      setHint(`Choose a target for ${c.name}.${touch ? '' : ' Esc to cancel.'}`);
      return;
    }
    send(plays.find((a) => a.target === undefined) ?? plays[0]);
  }

  function clickUnit(uid: number, owner: 0 | 1) {
    if (sel && targets.has(uid)) {
      const a = sel.kind === 'hand'
        ? legal.find((x) => x.type === 'play' && x.uid === sel.uid && x.target === uid && !!x.ape === pendingApe(sel.uid))
        : legal.find((x) => x.type === 'attack' && x.attacker === sel.uid && x.target === uid);
      if (a) { send(a); return; }
    }
    if (owner === seat && readyUnits.has(uid)) {
      if (sel?.kind === 'unit' && sel.uid === uid) { setSelected(null); setHint(null); return; }
      setSelected({ kind: 'unit', uid });
      setHint('Choose a target: an enemy unit or the enemy Treasury. Guard units must be hit first.');
      return;
    }
    if (owner === seat && myTurn) {
      const u = v.players[me].board.find((x) => x.uid === uid);
      if (u && u.attacksThisTurn > 0) setHint('That unit already attacked this turn.');
      else if (u && u.summonedTurn === v.turn && !u.keywords.includes('rush')) setHint('Units can’t attack the turn they’re played (unless Rush).');
    }
  }

  function clickTreasury(owner: 0 | 1) {
    if (owner === seat || sel?.kind !== 'unit' || !targets.has('treasury')) return;
    const a = legal.find((x) => x.type === 'attack' && x.attacker === sel.uid && x.target === 'treasury');
    if (a) send(a);
  }

  // Drag and drop: the same moves as tapping, resolved from where the card was let go.
  drag.current = {
    canDrag: (src) => myTurn && (src.kind === 'hand' ? playableHand.has(src.uid) : readyUnits.has(src.uid)),
    start: (src) => { setSelected(src); setHint(null); apeChoice.current.set(src.uid, false); },
    drop: (src, t) => {
      if (src.kind === 'unit') {
        const target = t?.kind === 'unit' ? t.uid : t?.kind === 'treasury' && t.side === op ? 'treasury' : undefined;
        const a = target !== undefined && legal.find((x) => x.type === 'attack' && x.attacker === src.uid && x.target === target);
        if (a) { send(a); return; }
        setSelected(null);
        if (t && t.kind !== 'board') setHint('Can’t attack that. Guard units must be hit first.');
        return;
      }
      if (t?.kind === 'unit' || t?.kind === 'treasury') {
        const target = t.kind === 'unit' ? t.uid : 'treasury';
        const a = legal.find((x): x is PlayAction => x.type === 'play' && x.uid === src.uid && x.target === target && !x.ape && !x.condition);
        if (a) { send(a); return; }
      }
      if (t?.kind === 'board') { setSelected(null); commitHand(src.uid); return; }
      setSelected(null);
      if (t) setHint('That card can’t target there.');
    },
  };

  const armedHand = sel?.kind === 'hand' ? v.hand.find((h) => h.uid === sel.uid) : undefined;
  const armedPlays = armedHand ? legal.filter((a): a is PlayAction => a.type === 'play' && a.uid === armedHand.uid) : [];
  const needsTarget = armedPlays.length > 0 && armedPlays.every((a) => a.target !== undefined && !a.condition) && !armedPlays.some((a) => a.ape);
  const movesLeft = myTurn && (playableHand.size > 0 || readyUnits.size > 0);

  const swarmBonus = (side: 0 | 1, u: UnitState) =>
    u.keywords.includes('swarm') ? v.players[side].board.filter((x) => x.uid !== u.uid && x.keywords.includes('swarm')).length : 0;

  const now = Date.now() + skew.current;

  return (
    <div className={`match ${myTurn ? 'my-turn' : ''} ${compact ? 'compact' : ''}`}>
      <FxLayer events={m.events} seat={seat} arena={arenaRef} races={[raceName(races[0]), raceName(races[1])]} />
      <div className="arena" ref={arenaRef} onClick={() => { if (sel) { setSelected(null); setHint(null); } }}>
        <Side s={s} side={op} isMe={false} hits={m.hits}
          onTreasury={() => clickTreasury(op)} treasuryTarget={!!sel && sel.kind === 'unit' && targets.has('treasury')}>
          <div className="lane" aria-label="Opponent board">
            {v.players[op].board.length === 0 && <span className="lane-empty">No units</span>}
            {v.players[op].board.map((u) => (
              <GameCard key={u.uid} size="board" cardId={u.cardId} unit={u} bonusAttack={swarmBonus(op, u)}
                targetable={targets.has(u.uid)} hit={m.hits.has(String(u.uid))}
                onClick={targets.has(u.uid) ? () => clickUnit(u.uid, op) : undefined} onHover={setPreview} />
            ))}
          </div>
        </Side>

        <TurnBar s={s} now={now} myTurn={myTurn} sending={m.sending} hint={hint} confirmEnd={touch && movesLeft} compact={compact} onLog={() => setLogOpen(true)}
          onEnd={() => send({ type: 'endTurn' })} onConcede={() => setModal({ kind: 'concede' })}
          onShowResult={!resultOpen ? () => setResultOpen(true) : undefined} />

        <Side s={s} side={me} isMe={seat !== null} hits={m.hits}>
          <div className="lane" aria-label={seat !== null ? 'Your board' : 'Board'}>
            {v.players[me].board.length === 0 && <span className="lane-empty">{seat !== null ? 'Play units from your hand' : 'No units'}</span>}
            {v.players[me].board.map((u) => (
              <GameCard key={u.uid} size="board" cardId={u.cardId} unit={u} bonusAttack={swarmBonus(me, u)}
                ready={readyUnits.has(u.uid)} selected={sel?.kind === 'unit' && sel.uid === u.uid}
                targetable={targets.has(u.uid)} hit={m.hits.has(String(u.uid))}
                onClick={seat !== null ? () => clickUnit(u.uid, me) : undefined} onHover={setPreview} />
            ))}
          </div>
        </Side>

        {seat !== null && (
          <div className="hand" aria-label="Your hand" style={{ ['--n' as string]: Math.max(1, v.hand.length) }}>
            {touch && armedHand && (
              <div className="armed" role="status" onClick={(e) => e.stopPropagation()}>
                <div className="armed-text">
                  <b>{card(armedHand.cardId).name}</b>
                  <span>{card(armedHand.cardId).text}</span>
                </div>
                <button className="btn btn-ghost icon-only" onClick={() => setZoom(armedHand.cardId)} aria-label="Card details">ⓘ</button>
                {needsTarget
                  ? <span className="armed-hint">Tap a glowing target</span>
                  : <button className="btn btn-primary" onClick={() => commitHand(armedHand.uid)} disabled={m.sending}>Play</button>}
              </div>
            )}
            {v.hand.map((h) => {
              const c = card(h.cardId);
              return (
                <GameCard key={h.uid} handUid={h.uid} cardId={h.cardId} cost={Math.max(0, c.cost - v.players[me].discount)}
                  playable={playableHand.has(h.uid)} dimmed={myTurn && !playableHand.has(h.uid)}
                  selected={sel?.kind === 'hand' && sel.uid === h.uid}
                  onClick={() => clickHand(h.uid)} onHover={setPreview} />
              );
            })}
            {v.hand.length === 0 && <span className="lane-empty">Your hand is empty</span>}
          </div>
        )}
      </div>

      <aside className="sidebar">
        <Preview cardId={preview ?? (sel?.kind === 'hand' ? v.hand.find((h) => h.uid === sel.uid)?.cardId ?? null : null)} />
        <Log events={m.events} seat={seat} races={races} />
        <p className="muted small mono">match {shortAddr(s.matchId)} · seq {s.seq} · log {shortAddr(s.head)}</p>
      </aside>

      {m.offline && !m.error && (
        <div className="toast info" role="status"><span className="spinner" /> <span>Reconnecting to the referee… your match is saved and continues where it stopped.</span></div>
      )}
      {m.error && (
        <div className="toast err" role="alert"><span>{m.error}</span><button onClick={m.clearError} aria-label="Dismiss">✕</button></div>
      )}

      {modal?.kind === 'ape' && (
        <Dialog title="Ape in?" onClose={() => setModal(null)}>
          <p className="muted">Ape plays {cardName(v, modal.uid)} for 2 less Gas, with a random downside: lose 2 Treasury, discard a random card, or the unit enters with −1 health.</p>
          <div className="choice-list">
            <button className="choice" onClick={() => continuePlay(modal.uid, false)}><b>Play normally</b><span>{costOf(v, modal.uid)} Gas</span></button>
            <button className="choice ape" onClick={() => continuePlay(modal.uid, true)}><b>Ape in</b><span>{Math.max(0, costOf(v, modal.uid) - 2)} Gas · random downside</span></button>
          </div>
        </Dialog>
      )}

      {modal?.kind === 'prediction' && (
        <Dialog title="Foresee" onClose={() => setModal(null)}>
          <p className="muted">What will your opponent do on their next turn? It stays face-down until it resolves. Bolder calls pay more; wrong calls backfire.</p>
          <div className="choice-list">
            {legal.filter((a): a is PlayAction => a.type === 'play' && a.uid === modal.uid && !!a.ape === !!modal.ape && !!a.condition).map((a) => (
              <button key={a.condition} className="choice" onClick={() => send(a)}>
                <b>{PREDICTION_LABELS[a.condition as PredictionCondition]}</b>
                <span className="tier">{'◆'.repeat(PREDICTION_TIERS[a.condition as PredictionCondition])} Odds tier {PREDICTION_TIERS[a.condition as PredictionCondition]}</span>
              </button>
            ))}
          </div>
        </Dialog>
      )}

      {modal?.kind === 'concede' && (
        <Dialog title="Concede?" onClose={() => setModal(null)}>
          <p className="muted">The match ends now as a loss.</p>
          <div className="row-end">
            <button className="btn" onClick={() => setModal(null)}>Keep playing</button>
            <button className="btn btn-danger-solid" disabled={m.sending} onClick={() => send({ type: 'concede' })}>Concede</button>
          </div>
        </Dialog>
      )}

      {s.phase === 'ended' && resultOpen && <Result s={s} events={m.events} onClose={() => setResultOpen(false)} />}
      {logOpen && (
        <Dialog title="Match log" onClose={() => setLogOpen(false)}>
          <Log events={m.events} seat={seat} races={races} />
        </Dialog>
      )}
      {zoom !== null && <CardZoom cardId={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}

/** Seat shown first in summaries: the viewer, or seat 0 for spectators. */
const firstSeat = (seat: 0 | 1 | null): 0 | 1 => seat ?? 0;
const cardName = (v: NonNullable<MatchSnapshot['view']>, uid: number) => card(v.hand.find((h) => h.uid === uid)!.cardId).name;
const costOf = (v: NonNullable<MatchSnapshot['view']>, uid: number) => {
  const me = v.you ?? 0;
  return Math.max(0, card(v.hand.find((h) => h.uid === uid)!.cardId).cost - v.players[me].discount);
};

// ─── Player side: identity, Treasury, Gas, deck, hand, predictions ────────────
export function Side({ s, side, isMe, hits, children, onTreasury, treasuryTarget }: {
  s: MatchSnapshot; side: 0 | 1; isMe: boolean; hits: Set<string>; children: React.ReactNode;
  onTreasury?: () => void; treasuryTarget?: boolean;
}) {
  const v = s.view!;
  const p = v.players[side];
  const info = s.players[side];
  const active = s.phase === 'active' && v.active === side;
  const low = p.treasury <= 8;
  return (
    <section className={`side ${isMe ? 'me' : 'opp'} ${active ? 'active' : ''}`} style={{ ['--rc' as string]: `var(--${p.race})` }}
      aria-label={isMe ? 'You' : s.seat !== null ? 'Opponent' : raceName(p.race)}>
      <div className="side-bar">
        <div className="who">
          <img className="avatar" src={avatarSvg(info.address)} alt="" />
          <div>
            <div className="who-name">
              <span className="who-prefix">{isMe ? 'You · ' : s.seat !== null ? 'Opponent · ' : ''}</span><span style={{ color: 'var(--rc)' }}>{raceName(p.race)}</span>
              {info.agent && <span className="badge agent">Agent</span>}
              {info.cosmetics?.badge && <span className={`cos-badge b-${info.cosmetics.badge.slice(6)}`} title={cosmetic(info.cosmetics.badge)?.name}>{emblem(info.cosmetics.badge)}</span>}
            </div>
            <div className="mono muted small">
              {info.cosmetics?.title && <span className="cos-title">{emblem(info.cosmetics.title)} {cosmetic(info.cosmetics.title)?.name}</span>}
              {shortAddr(info.address)}
            </div>
          </div>
        </div>
        <button
          data-treasury={side}
          className={`treasury ${low ? 'low' : ''} ${treasuryTarget ? 'target' : ''} ${hits.has(`treasury-${side}`) ? 'hit' : ''}`}
          onClick={(e) => { e.stopPropagation(); onTreasury?.(); }} disabled={!treasuryTarget}
          aria-label={`${isMe ? 'Your' : s.seat !== null ? 'Opponent' : raceName(p.race)} Treasury: ${p.treasury}${treasuryTarget ? '. Attack it' : ''}`}
        >
          <span className="t-label">Treasury</span><span className="t-val">{Math.max(0, p.treasury)}</span>
        </button>
        <div className="gas" aria-label={`Gas ${p.gas} of ${p.maxGas}`}>
          <div className="gas-pips">{Array.from({ length: 10 }, (_, i) => <i key={i} className={i < p.gas ? 'on' : i < p.maxGas ? 'spent' : ''} />)}</div>
          <span className="small muted">Gas {p.gas}/{p.maxGas}{p.discount ? ` · next card −${p.discount}` : ''}</span>
        </div>
        <div className="side-stats">
          <span title="Cards left in deck">Deck {p.deckCount}</span>
          {!isMe && <span className="opp-hand" title="Cards in hand">{Array.from({ length: Math.min(p.handCount, 10) }, (_, i) => <CardBack key={i} small back={info.cosmetics?.cardBack} />)}<b>{p.handCount}</b></span>}
        </div>
        <div className="side-tags">
          {p.assets.map((a) => <span key={a.uid} className="tag" title={card(a.cardId).text}>⬢ {card(a.cardId).name}</span>)}
          {p.predictions.map((x) => ('hidden' in x
            ? <span key={x.uid} className="tag pred" title="Face-down prediction, resolves at the end of the next turn">◆ Face-down prediction</span>
            : <span key={x.uid} className="tag pred" title={PREDICTION_LABELS[x.condition]}>◆ {card(x.cardId).name}: {PREDICTION_LABELS[x.condition]}</span>))}
          {p.automationsQueued > 0 && <span className="tag" title="Fires at the start of their next turn">⚙ {p.automationsQueued} automated</span>}
        </div>
      </div>
      {children}
    </section>
  );
}

// ─── Turn bar: whose turn, clock, end turn ────────────────────────────────────
function TurnBar({ s, now, myTurn, sending, hint, confirmEnd, compact, onLog, onEnd, onConcede, onShowResult }: {
  s: MatchSnapshot; now: number; myTurn: boolean; sending: boolean; hint: string | null;
  /** Phone layout: secondary actions (log, sound, concede, leave) move into a ⋯ menu so the bar stays one row. */
  compact?: boolean; onLog?: () => void;
  /** Ask for a second tap before ending a turn that still has moves left (touch screens: no accidental end). */
  confirmEnd?: boolean;
  onEnd: () => void; onConcede: () => void; onShowResult?: () => void;
}) {
  const [, tick] = useState(0);
  const [askEnd, setAskEnd] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const off = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [menu]);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 250); return () => clearInterval(t); }, []);
  useEffect(() => { if (!askEnd) return; const t = setTimeout(() => setAskEnd(false), 3000); return () => clearTimeout(t); }, [askEnd]);
  useEffect(() => { if (!myTurn) setAskEnd(false); }, [myTurn]);
  const end = () => {
    if (confirmEnd && !askEnd) { setAskEnd(true); return; }
    setAskEnd(false);
    onEnd();
  };
  const v = s.view!;
  const c = s.clock;
  const turnLeft = c ? Math.max(0, c.turnEndsAt - now) : 0;
  const bank = c ? c.bank[c.active] : 0;
  const inBank = c && turnLeft === 0;
  const bankLeft = inBank ? Math.max(0, bank - (now - c!.turnEndsAt)) : bank;
  const pct = Math.min(100, (turnLeft / 45000) * 100);
  const label = s.phase !== 'active' ? 'Match over'
    : s.seat === null ? `${raceName(v.players[v.active].race)} to move`
    : myTurn ? 'Your turn' : 'Opponent’s turn';
  return (
    <div className="turnbar" onClick={(e) => e.stopPropagation()}>
      {compact && (
        <div className="tb-menu-wrap" ref={menuRef}>
          <button className="btn btn-ghost icon-only tb-menu-btn" onClick={() => setMenu((x) => !x)} aria-haspopup="menu" aria-expanded={menu} aria-label="Match menu">⋯</button>
          {menu && (
            <div className="menu tb-menu" role="menu" onClick={() => setMenu(false)}>
              <button className="item" role="menuitem" onClick={onLog}>Match log</button>
              <MuteButton item />
              <Link className="item" role="menuitem" to="/play">Back to Play <span className="muted">(match keeps running)</span></Link>
              {s.phase === 'active' && s.seat !== null && <button className="item btn-danger" role="menuitem" onClick={onConcede}>Concede…</button>}
            </div>
          )}
        </div>
      )}
      <div className="tb-left">
        <span className={`turn-pill ${myTurn ? 'mine' : ''}`}>{label}</span>
        <span className="muted small">Turn {v.turn} · {s.mode}</span>
      </div>
      {c && s.phase === 'active' && (
        <div className={`clock ${inBank ? 'bank' : turnLeft < 10000 ? 'warn' : ''}`} role="timer" aria-label="Turn timer">
          <div className="clock-bar"><i style={{ transform: `scaleX(${inBank ? 0 : pct / 100})` }} /></div>
          <span className="small">{inBank ? `Bank ${Math.ceil(bankLeft / 1000)}s` : `${Math.ceil(turnLeft / 1000)}s`}<span className="muted clock-bank"> · bank {Math.ceil(bank / 1000)}s</span></span>
        </div>
      )}
      <span className={`hint-inline ${hint ? 'on' : ''}`} role="status" title={hint ?? undefined}>{hint ?? ''}</span>
      <div className="tb-right">
        {!compact && <MuteButton />}
        {!compact && s.phase === 'active' && s.seat !== null && <button className="btn btn-ghost" onClick={onConcede}>Concede</button>}
        {onShowResult && <button className="btn btn-primary" onClick={onShowResult}>Show result</button>}
        {myTurn && (
          <button className={`btn btn-primary end-turn ${askEnd ? 'confirm' : ''}`} onClick={end} disabled={sending}>
            {sending ? <span className="spinner" /> : askEnd ? 'Tap again to end' : 'End turn'}
          </button>
        )}
      </div>
    </div>
  );
}

function MuteButton({ item }: { item?: boolean }) {
  const [muted, setM] = useState(isMuted());
  if (item) return <button className="item" role="menuitem" onClick={() => { setMuted(!muted); setM(!muted); }}>{muted ? '🔇 Sound off' : '🔊 Sound on'}</button>;
  return (
    <button className="btn btn-ghost icon-only" onClick={() => { setMuted(!muted); setM(!muted); }}
      aria-label={muted ? 'Unmute sounds' : 'Mute sounds'} title={muted ? 'Sound off' : 'Sound on'}>{muted ? '🔇' : '🔊'}</button>
  );
}

export function Preview({ cardId }: { cardId: number | null }) {
  if (cardId === null) {
    return <div className="preview empty muted small">Hover or focus a card to read it here.</div>;
  }
  const c = card(cardId);
  return (
    <div className="preview">
      <GameCard cardId={cardId} size="preview" />
      <div className="preview-kw">
        {c.keywords.filter((k) => KEYWORD_LABEL[k]).map((k) => (
          <p key={k}><b>{KEYWORD_LABEL[k]}</b> {KEYWORD_HELP[k]}</p>
        ))}
        <p className="muted small">{c.rarity} · {c.faction === 'neutral' ? 'Neutral' : `${RACE_INFO[c.faction].name} (${RACE_INFO[c.faction].chain})`}</p>
      </div>
    </div>
  );
}

export function Log({ events, seat, races }: { events: GameEvent[]; seat: number | null; races: [Race, Race] }) {
  const lines = useMemo(() => events.map((e) => describeEvent(e, seat, races)).filter((x): x is string => !!x), [events, seat, races]);
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [lines.length]);
  return (
    <div className="log">
      <h2 className="sub">Match log</h2>
      <ol ref={ref} aria-live="polite">
        {lines.slice(-120).map((l, i) => <li key={i} className={l.startsWith('Turn ') ? 'turn' : ''}>{l}</li>)}
      </ol>
    </div>
  );
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button.choice, .row-end .btn')?.focus(); }, []);
  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head"><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

// ─── Result: outcome + co-signing for on-chain settlement ─────────────────────
function Result({ s, events, onClose }: { s: MatchSnapshot; events: GameEvent[]; onClose: () => void }) {
  const { client } = useAuth();
  const [signing, setSigning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [settle, setSettle] = useState<{ byReferee?: boolean } | null>(null);
  const v = s.view!;
  const seat = s.seat;
  const signed = seat !== null && !!s.resultSigned?.[seat];
  const both = !!s.resultSigned?.[0] && !!s.resultSigned?.[1];
  const back = useReturnedWhilePending(signing);

  useEffect(() => {
    if (!client || !both) return;
    client.settlement(s.matchId).then((x) => setSettle(x as { byReferee?: boolean })).catch(() => {});
  }, [client, both, s.matchId]);

  const outcome = v.winner === 'draw' ? 'Draw' : seat === null ? `${raceName(v.players[v.winner as 0 | 1].race)} win` : v.winner === seat ? 'Victory' : 'Defeat';
  const tone = v.winner === 'draw' || seat === null ? 'neutral' : v.winner === seat ? 'win' : 'loss';
  const reason = { treasury: 'Treasury drained', concede: 'Conceded', turnLimit: 'Turn limit reached', timeout: 'Ran out of time' }[v.endReason ?? 'treasury'];
  const winnerSprite = v.winner === 'draw' ? null : RACE_INFO[v.players[v.winner as 0 | 1].race].sprite;

  const sign = async () => {
    setErr(null); setSigning(true);
    try { await client!.signResult(s.matchId); } catch (e) {
      const msg = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message;
      setErr(/reject|denied|cancel/i.test(msg) ? 'Signature cancelled in your wallet.' : msg);
    } finally { setSigning(false); }
  };

  return (
    <div className="modal-bg result-bg">
      <div className={`modal result ${tone}`} role="dialog" aria-modal="true" aria-label={outcome}>
        {winnerSprite && <img className="result-sprite" src={spriteSvg(winnerSprite)} alt="" />}
        <h2 className="result-title">{outcome}</h2>
        <p className="muted">{reason} · turn {v.turn} · Treasury {Math.max(0, v.players[firstSeat(seat)].treasury)} – {Math.max(0, v.players[1 - firstSeat(seat)].treasury)}</p>
        <MatchStats events={events} seat={firstSeat(seat)} spectator={seat === null} />
        {seat !== null && <RatingChange s={s} seat={seat} />}
        {seat !== null && <QuestProgress />}
        {seat !== null && s.mode !== 'league' && !s.players[seat === 0 ? 1 : 0].bot && <Rematch s={s} seat={seat} />}
        {seat !== null && (
          <div className="result-sign">
            {!signed ? (
              <>
                <p>Sign the result with your wallet so it can be recorded on-chain{s.mode !== 'casual' ? ' and count for your rating' : ''}. No gas.</p>
                {signing && (
                  <div className="sig-state pending" role="status">
                    <span className="spinner" />
                    <span>{back
                      ? 'Signature pending: nothing has arrived from your wallet yet. If you approved it there, it lands in a moment; otherwise sign again.'
                      : 'Signature pending: approve it in your wallet.'}</span>
                  </div>
                )}
                {err && <div className="sig-state failed" role="alert"><b>Signature failed</b><span>{err}</span></div>}
                <button className="btn btn-primary btn-block" onClick={sign} disabled={signing && !back}>
                  {signing && !back ? <><span className="spinner" /> Check your wallet…</> : err || back ? 'Sign again' : 'Sign result'}
                </button>
              </>
            ) : both ? (
              <SettleNow match={s} ready={!!settle && !settle.byReferee} />
            ) : (
              <RefereeWait s={s} />
            )}
          </div>
        )}
        <div className="row-end">
          <Link className="btn btn-ghost" to={`/matches/${s.matchId}`}>Replay</Link>
          <button className="btn" onClick={onClose}>View board</button>
          <Link className="btn btn-primary" to="/play">Play again</Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Rematch: challenge your opponent again (a casual challenge addressed to them). If they asked first, accept
 * theirs instead; either way both players land in the new match.
 */
function Rematch({ s, seat }: { s: MatchSnapshot; seat: 0 | 1 }) {
  const { client } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mine, setMine] = useState<string | null>(null);
  const [theirs, setTheirs] = useState<string | null>(null);
  const race = s.players[seat].race;

  // The match this result screen shows right now: a slow answer for a previous one must not land here.
  const current = useRef(s.matchId);
  current.current = s.matchId;
  const poll = useCallback(async () => {
    if (!client) return;
    try {
      const r = await client.challenges();
      if (current.current !== s.matchId) return;
      setTheirs(r.incoming.find((c) => c.rematchOf === s.matchId)?.code ?? null);
      // A rematch still open, or accepted and waiting for you to join. Once that match is under way (or if you
      // come Back here later) there's nothing to wait for.
      const out = r.outgoing.find((c) => c.rematchOf === s.matchId && (c.state === 'open' || c.matchPhase === 'reveal'));
      setMine(out?.code ?? null);
    } catch { /* server without challenges */ }
  }, [client, s.matchId]);
  // An opponent's rematch offer (or their answer to yours) arrives as a 'challenge' notice.
  const up = useLiveTopic(client ? 'me' : null, (e) => {
    if (e.kind === 'challenge' || e.kind === 'reconnect') poll();
  });
  useEffect(() => {
    poll();
    const t = setInterval(poll, up ? 30_000 : 3000);
    return () => clearInterval(t);
  }, [poll, up]);

  const ask = async () => {
    setErr(null); setBusy(true);
    try { setMine((await client!.createChallenge({ race, rematchOf: s.matchId })).code); } catch (e) { setErr(friendlyError(e)); } finally { setBusy(false); }
  };
  const accept = async () => {
    setErr(null); setBusy(true);
    try {
      if (mine) await client!.cancelChallenge(mine).catch(() => {}); // both asked at once: take theirs
      navigate(`/match/${await client!.acceptChallenge(theirs!, { race })}`);
    } catch (e) { setErr(friendlyError(e)); setBusy(false); }
  };

  return (
    <div className="rematch">
      {theirs ? (
        <div className="rematch-offer" role="status">
          <b>⚔ Your opponent wants a rematch!</b>
          <button className="btn btn-primary" onClick={accept} disabled={busy}>{busy ? <span className="spinner" /> : null} Accept rematch</button>
        </div>
      ) : mine ? (
        <ChallengeWaiting code={mine} rematch onDone={() => setMine(null)} />
      ) : (
        <button className="btn btn-block" onClick={ask} disabled={busy}>{busy ? <span className="spinner" /> : '⚔'} Rematch</button>
      )}
      {err && <div className="alert err">{err}</div>}
    </div>
  );
}

/** Quest progress after the match: refetched now that the referee has counted it. */
function QuestProgress() {
  const qc = useQueryClient();
  // The live 'quests' notice usually lands at the same moment: join an in-flight fetch rather than restart it, so the
  // result screen doesn't spend the session's rate limit before the player signs (the server records before the match ends).
  useEffect(() => {
    qc.invalidateQueries({ queryKey: ['quests'] }, { cancelRefetch: false });
    qc.invalidateQueries({ queryKey: ['pass'] }, { cancelRefetch: false });
  }, [qc]);
  return <div className="result-quests"><PassPanel compact /><QuestPanel compact /></div>;
}

/** Damage, kills and cards played for the viewer (counting up), plus their MVP card. */
function MatchStats({ events, seat, spectator }: { events: GameEvent[]; seat: 0 | 1; spectator: boolean }) {
  const sum = useMemo(() => summarize(events), [events]);
  const me = sum.sides[seat];
  const dmg = useCountUp(me.damage, 900, 0, 250);
  const kills = useCountUp(me.kills, 700, 0, 400);
  const played = useCountUp(me.cardsPlayed, 700, 0, 550);
  const mvp = sum.mvp[seat];
  const mvpDmg = useCountUp(mvp?.damage ?? 0, 900, 0, 800);
  if (!events.length) return null;
  return (
    <div className="result-stats">
      <div className="rs-tiles">
        <div className="rs-tile"><b>{dmg}</b><span>Damage dealt</span></div>
        <div className="rs-tile"><b>{kills}</b><span>Units destroyed</span></div>
        <div className="rs-tile"><b>{played}</b><span>Cards played</span></div>
      </div>
      {mvp && (
        <div className="rs-mvp">
          <GameCard cardId={mvp.cardId} size="mini" />
          <div><span className="rs-mvp-tag">{spectator ? 'Top card' : 'Your MVP'}</span><b>{card(mvp.cardId).name}</b><span className="muted small">{mvpDmg} damage{me.biggestHit ? ` · biggest hit ${me.biggestHit}` : ''}</span></div>
        </div>
      )}
    </div>
  );
}

/**
 * Rating change for rated modes, from MatchSettlement. Before settlement it's projected with the
 * contract's own Elo table (expectedScore, K = 32); after, it counts from the rating seen before settling.
 */
function RatingChange({ s, seat }: { s: MatchSnapshot; seat: 0 | 1 }) {
  const { chainId, contracts } = useHub();
  const rated = s.mode === 'ranked' || s.mode === 'human';
  const season = s.result?.season ?? 0;
  const me = s.players[seat].address as Hex, op = s.players[1 - seat].address as Hex;
  const { stats } = useSeasonStats(rated && contracts ? [me, op] : [], season);
  const { settled } = useSettled(rated && contracts ? [s] : []);
  const ra = stats.get(me.toLowerCase())?.rating, rb = stats.get(op.toLowerCase())?.rating;
  const done = settled.get(s.matchId);
  const key = `ff.prerating.${s.matchId}`;
  const cached = (() => { try { return Number(sessionStorage.getItem(key)) || undefined; } catch { return undefined; } })();
  if (done === false && ra !== undefined && !cached) { try { sessionStorage.setItem(key, String(ra)); } catch { /* ignore */ } }
  const exp = useReadContract({
    address: contracts?.MatchSettlement, abi: matchSettlementAbi, functionName: 'expectedScore',
    args: [BigInt(ra ?? 1200), BigInt(rb ?? 1200)], chainId: chainId as never,
    query: { enabled: rated && !!contracts && done === false && ra !== undefined && rb !== undefined },
  });
  const winner = s.view?.winner;
  const score = winner === 'draw' ? 500 : winner === seat ? 1000 : 0;
  const projected = exp.data !== undefined && ra !== undefined ? Math.max(100, ra + Math.trunc((32 * (score - Number(exp.data))) / 1000)) : undefined;
  const from = done ? (cached ?? ra ?? 0) : (ra ?? 0);
  const to = done ? (ra ?? 0) : (projected ?? ra ?? 0);
  const shown = useCountUp(to, 1100, from, 1000);
  if (!rated) return <p className="rs-rating muted small">{s.mode === 'league' ? 'League standings update when the referee settles this match.' : 'Casual match: no rating change.'}</p>;
  if (!contracts) return null;
  if (ra === undefined || (done === false && projected === undefined)) return <p className="rs-rating muted small">Loading rating…</p>;
  const delta = to - from;
  return (
    <p className={`rs-rating ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}`}>
      <span className="muted small">{done ? 'Rating' : 'Rating once settled'}</span>
      <b>{shown}</b>
      {delta !== 0 && <span className="rs-delta">{delta > 0 ? '▲' : '▼'} {Math.abs(delta)}</span>}
    </p>
  );
}

function SettleNow({ match, ready }: { match: SettledQuery; ready: boolean }) {
  const { matchId } = match;
  const { contracts } = useHub();
  const settle = useSettleMatch();
  const { settled } = useSettled([match]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (settled.get(matchId)) return <p className="ok">✓ Settled on-chain. It counts in your record{' '}<Link to="/matches">on the Matches page</Link>.</p>;
  if (!contracts) return <p className="ok">✓ Both players signed. This server runs off-chain, so there is nothing to settle.</p>;
  const go = async () => {
    setErr(null); setBusy(true);
    try { await settle(matchId); } catch (e) { setErr(friendlyError(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <p className="ok">✓ Both players signed. Anyone can now submit the result to MatchSettlement (one transaction, testnet gas).</p>
      {err && <div className="alert err">{err}</div>}
      <button className="btn btn-primary btn-block" onClick={go} disabled={busy || !ready}>
        {busy ? <><span className="spinner" /> Settling…</> : ready ? 'Settle on-chain' : 'Preparing settlement…'}
      </button>
    </>
  );
}

/** You signed, your opponent hasn't: explain what the referee does about it. */
function RefereeWait({ s }: { s: MatchSnapshot }) {
  const r = s.referee;
  const won = s.view?.winner === s.seat;
  if (r?.state === 'settled') return <p className="ok">✓ Your opponent didn’t sign, so the referee settled the result on-chain with your signature. It counts in your record.</p>;
  if (r?.state === 'submitting') return <p className="ok"><span className="spinner" /> Your opponent didn’t sign. The referee is settling the result on-chain now…</p>;
  if (r?.state === 'failed') {
    return <div className="alert err">The referee couldn’t settle this result{r.willRetry ? ' yet and will retry' : ''}: {r.error}</div>;
  }
  if (won && s.refereeAt != null) {
    return <p className="ok sig-state done">✓ You signed. Waiting for your opponent’s signature. If they don’t sign, the referee settles it on-chain with yours {inTime(s.refereeAt)}.</p>;
  }
  return <p className="ok sig-state done">✓ You signed. Waiting for your opponent’s signature.</p>;
}
