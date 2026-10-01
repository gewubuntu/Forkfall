import {
  card, PREDICTION_LABELS, PREDICTION_TIERS,
  type Action, type GameEvent, type PredictionCondition, type Race, type UnitState,
} from '@forkfall/engine';
import type { MatchSnapshot } from '@forkfall/sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Hex } from 'viem';
import { useAuth } from '../auth/AuthProvider.tsx';
import { CardBack, GameCard } from '../components/GameCard.tsx';
import { describeEvent, KEYWORD_HELP, KEYWORD_LABEL, RACE_INFO, raceName } from '../game/meta.ts';
import { useMatch } from '../game/useMatch.ts';
import { avatarSvg, spriteSvg } from '../lib/art.ts';
import { shortAddr } from '../lib/format.ts';

type PlayAction = Extract<Action, { type: 'play' }>;
type Selection = { kind: 'hand' | 'unit'; uid: number } | null;
type Modal = { kind: 'ape' | 'prediction'; uid: number; ape?: boolean } | { kind: 'concede' } | null;

export function Match() {
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
    if (sel?.kind === 'hand' && sel.uid === uid) { setSelected(null); setHint(null); return; }
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
      setHint(`Choose a target for ${c.name}. Esc to cancel.`);
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

  const swarmBonus = (side: 0 | 1, u: UnitState) =>
    u.keywords.includes('swarm') ? v.players[side].board.filter((x) => x.uid !== u.uid && x.keywords.includes('swarm')).length : 0;

  const now = Date.now() + skew.current;

  return (
    <div className={`match ${myTurn ? 'my-turn' : ''}`}>
      <div className="arena" onClick={() => { if (sel) { setSelected(null); setHint(null); } }}>
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

        <TurnBar s={s} now={now} myTurn={myTurn} sending={m.sending} hint={hint}
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
          <div className="hand" aria-label="Your hand">
            {v.hand.map((h) => {
              const c = card(h.cardId);
              return (
                <GameCard key={h.uid} cardId={h.cardId} cost={Math.max(0, c.cost - v.players[me].discount)}
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
            <button className="btn btn-danger-solid" onClick={() => send({ type: 'concede' })}>Concede</button>
          </div>
        </Dialog>
      )}

      {s.phase === 'ended' && resultOpen && <Result s={s} onClose={() => setResultOpen(false)} />}
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
function Side({ s, side, isMe, hits, children, onTreasury, treasuryTarget }: {
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
              {isMe ? 'You · ' : s.seat !== null ? 'Opponent · ' : ''}<span style={{ color: 'var(--rc)' }}>{raceName(p.race)}</span>
              {info.agent && <span className="badge agent">Agent</span>}
            </div>
            <div className="mono muted small">{shortAddr(info.address)}</div>
          </div>
        </div>
        <button
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
          {!isMe && <span className="opp-hand" title="Cards in hand">{Array.from({ length: Math.min(p.handCount, 10) }, (_, i) => <CardBack key={i} small />)}<b>{p.handCount}</b></span>}
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
function TurnBar({ s, now, myTurn, sending, hint, onEnd, onConcede, onShowResult }: {
  s: MatchSnapshot; now: number; myTurn: boolean; sending: boolean; hint: string | null;
  onEnd: () => void; onConcede: () => void; onShowResult?: () => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 250); return () => clearInterval(t); }, []);
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
      <div className="tb-left">
        <span className={`turn-pill ${myTurn ? 'mine' : ''}`}>{label}</span>
        <span className="muted small">Turn {v.turn} · {s.mode}</span>
      </div>
      {c && s.phase === 'active' && (
        <div className={`clock ${inBank ? 'bank' : turnLeft < 10000 ? 'warn' : ''}`} role="timer" aria-label="Turn timer">
          <div className="clock-bar"><i style={{ width: `${inBank ? 0 : pct}%` }} /></div>
          <span className="small">{inBank ? `Bank ${Math.ceil(bankLeft / 1000)}s` : `${Math.ceil(turnLeft / 1000)}s`}<span className="muted"> · bank {Math.ceil(bank / 1000)}s</span></span>
        </div>
      )}
      <span className="hint-inline" role="status" title={hint ?? undefined}>{hint ?? ''}</span>
      <div className="tb-right">
        {s.phase === 'active' && s.seat !== null && <button className="btn btn-ghost" onClick={onConcede}>Concede</button>}
        {onShowResult && <button className="btn btn-primary" onClick={onShowResult}>Show result</button>}
        {myTurn && <button className="btn btn-primary end-turn" onClick={onEnd} disabled={sending}>{sending ? <span className="spinner" /> : 'End turn'}</button>}
      </div>
    </div>
  );
}

function Preview({ cardId }: { cardId: number | null }) {
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

function Log({ events, seat, races }: { events: GameEvent[]; seat: number | null; races: [Race, Race] }) {
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

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
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
function Result({ s, onClose }: { s: MatchSnapshot; onClose: () => void }) {
  const { client } = useAuth();
  const [signing, setSigning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [settle, setSettle] = useState<{ byReferee?: boolean } | null>(null);
  const v = s.view!;
  const seat = s.seat;
  const signed = seat !== null && !!s.resultSigned?.[seat];
  const both = !!s.resultSigned?.[0] && !!s.resultSigned?.[1];

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
        {seat !== null && (
          <div className="result-sign">
            {!signed ? (
              <>
                <p>Sign the result with your wallet so it can be recorded on-chain{s.mode !== 'casual' ? ' and count for your rating' : ''}. No gas.</p>
                {err && <div className="alert err">{err}</div>}
                <button className="btn btn-primary btn-block" onClick={sign} disabled={signing}>
                  {signing ? <><span className="spinner" /> Check your wallet…</> : 'Sign result'}
                </button>
              </>
            ) : both ? (
              <p className="ok">✓ Both players signed. {settle ? 'Ready to settle on-chain.' : ''} One-click settlement arrives with the Matches screen; until then use <span className="mono">settle(string)</span> from the player guide.</p>
            ) : (
              <p className="ok">✓ You signed. Waiting for your opponent’s signature{s.mode !== 'casual' ? ' (the referee can settle without it after 10 minutes)' : ''}.</p>
            )}
          </div>
        )}
        <div className="row-end">
          <button className="btn" onClick={onClose}>View board</button>
          <Link className="btn btn-primary" to="/play">Play again</Link>
        </div>
      </div>
    </div>
  );
}
