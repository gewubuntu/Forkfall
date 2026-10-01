import { card, eventsFor, viewFor, type GameState, type Race, type UnitState } from '@forkfall/engine';
import { replayLog, verifyMoveSignatures, type MatchLog, type MatchSnapshot, type ReplayFrame } from '@forkfall/sdk';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Hex } from 'viem';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useHub } from '../chain/useHub.ts';
import { useSettled } from '../chain/useSettlement.ts';
import { GameCard } from '../components/GameCard.tsx';
import { raceName } from '../game/meta.ts';
import { shortAddr } from '../lib/format.ts';
import { Log, Preview, Side } from './Match.tsx';

const SPEEDS = [{ ms: 1400, label: '0.5×' }, { ms: 700, label: '1×' }, { ms: 300, label: '2×' }];

/**
 * Replays a finished match from its public signed log, in the browser, with the same rules engine
 * the referee runs. Every step is recomputed here; nothing is taken from the server's word.
 */
export function Replay() {
  const { id } = useParams();
  const matchId = id as Hex;
  const { client, me } = useAuth();
  const log = useQuery({ queryKey: ['log', matchId], queryFn: () => client!.log(matchId), enabled: !!client, staleTime: Infinity, retry: false });
  const replay = useMemo(() => (log.data ? replayLog(log.data) : null), [log.data]);

  if (log.error) {
    const running = /409|after the match ends/.test(String(log.error));
    return (
      <div className="page"><div className="panel empty">
        <h2>{running ? 'Match still running' : 'Match not found'}</h2>
        <p>{running ? 'The full log, with both seed reveals and decks, is published when the match ends.' : 'This server has no record of that match.'}</p>
        <div className="row-end" style={{ justifyContent: 'center' }}>
          {running && <Link className="btn btn-primary" to={`/match/${matchId}`}>Watch live</Link>}
          <Link className="btn" to="/matches">Back to Matches</Link>
        </div>
      </div></div>
    );
  }
  if (!log.data || !replay) return <div className="gate"><span className="spinner" aria-label="Loading replay" /></div>;
  const seat = log.data.players.findIndex((p) => p.address.toLowerCase() === me?.address.toLowerCase());
  return <Viewer log={log.data} frames={replay.frames} checks={replay.checks} viewerSeat={seat < 0 ? null : (seat as 0 | 1)} />;
}

function Viewer({ log, frames, checks, viewerSeat }: {
  log: MatchLog; frames: ReplayFrame[]; checks: ReturnType<typeof replayLog>['checks']; viewerSeat: 0 | 1 | null;
}) {
  const last = frames.length - 1;
  const [i, setI] = useState(last);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [flipped, setFlipped] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);

  useEffect(() => {
    if (!playing) return;
    if (i >= last) { setPlaying(false); return; }
    const t = setTimeout(() => setI((x) => Math.min(last, x + 1)), SPEEDS[speed].ms);
    return () => clearTimeout(t);
  }, [playing, i, last, speed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, select, textarea')) return;
      if (e.key === 'ArrowRight') { setPlaying(false); setI((x) => Math.min(last, x + 1)); }
      else if (e.key === 'ArrowLeft') { setPlaying(false); setI((x) => Math.max(0, x - 1)); }
      else if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [last]);

  const frame = frames[i];
  const state = frame.state;
  const bottom = ((viewerSeat ?? 0) ^ (flipped ? 1 : 0)) as 0 | 1;
  const top = (1 - bottom) as 0 | 1;
  const races: [Race, Race] = [log.players[0].race, log.players[1].race];
  const snap = useMemo(() => fullSnapshot(log, state, bottom), [log, state, bottom]);
  const events = useMemo(() => eventsFor(frames.slice(0, i + 1).flatMap((f) => f.events), null), [frames, i]);
  const hits = useMemo(() => {
    const h = new Set<string>();
    for (const e of frame.events) if (e.t === 'damage') h.add(e.uid === 'treasury' ? `treasury-${e.seat}` : String(e.uid));
    return h;
  }, [frame]);
  const swarm = (side: 0 | 1, u: UnitState) =>
    u.keywords.includes('swarm') ? state.players[side].board.filter((x) => x.uid !== u.uid && x.keywords.includes('swarm')).length : 0;

  const board = (side: 0 | 1) => (
    <div className="lane" aria-label={`${raceName(races[side])} board`}>
      {state.players[side].board.length === 0 && <span className="lane-empty">No units</span>}
      {state.players[side].board.map((u) => (
        <GameCard key={u.uid} size="board" cardId={u.cardId} unit={u} bonusAttack={swarm(side, u)} hit={hits.has(String(u.uid))} onHover={setPreview} />
      ))}
    </div>
  );
  const hand = (side: 0 | 1) => (
    <div className={`hand replay-hand ${side === top ? 'top' : ''}`} aria-label={`${raceName(races[side])} hand`}>
      {state.players[side].hand.map((h) => <GameCard key={h.uid} size="mini" cardId={h.cardId} onHover={setPreview} />)}
      {state.players[side].hand.length === 0 && <span className="lane-empty">Empty hand</span>}
    </div>
  );

  return (
    <div className="match replay">
      <div className="arena">
        {hand(top)}
        <Side s={snap} side={top} isMe={viewerSeat === top} hits={hits}>{board(top)}</Side>
        <div className="turnbar replay-bar">
          <div className="tb-left">
            <span className="turn-pill">{i === 0 ? 'Opening deal' : state.status === 'ended' && i === last ? 'Match over' : `Turn ${state.turn}`}</span>
            <span className="muted small rb-move">{describeStep(frames, i, races)}</span>
          </div>
          <div className="tb-right rb-controls" role="group" aria-label="Replay controls">
            <button className="icon-btn" onClick={() => { setPlaying(false); setI(0); }} aria-label="First move" disabled={i === 0}>⏮</button>
            <button className="icon-btn" onClick={() => { setPlaying(false); setI((x) => Math.max(0, x - 1)); }} aria-label="Previous move" disabled={i === 0}>◀</button>
            <button className="btn btn-primary rb-play" onClick={() => { if (i >= last) setI(0); setPlaying((p) => !p); }} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
            <button className="icon-btn" onClick={() => { setPlaying(false); setI((x) => Math.min(last, x + 1)); }} aria-label="Next move" disabled={i === last}>▶</button>
            <button className="icon-btn" onClick={() => { setPlaying(false); setI(last); }} aria-label="Last move" disabled={i === last}>⏭</button>
            <button className="btn btn-ghost rb-speed" onClick={() => setSpeed((s) => (s + 1) % SPEEDS.length)} aria-label={`Speed ${SPEEDS[speed].label}`}>{SPEEDS[speed].label}</button>
            <button className="btn btn-ghost" onClick={() => setFlipped((f) => !f)}>Flip</button>
          </div>
        </div>
        <input className="rb-scrub" type="range" min={0} max={last} value={i} aria-label={`Move ${i} of ${last}`}
          onChange={(e) => { setPlaying(false); setI(Number(e.target.value)); }} />
        <Side s={snap} side={bottom} isMe={viewerSeat === bottom} hits={hits}>{board(bottom)}</Side>
        {hand(bottom)}
      </div>

      <aside className="sidebar">
        <Verification log={log} checks={checks} />
        <Preview cardId={preview} />
        <Log events={events} seat={null} races={races} />
      </aside>
    </div>
  );
}

/** Snapshot for the shared board components, with both sides fully revealed (the log is public). */
function fullSnapshot(log: MatchLog, state: GameState, bottom: 0 | 1): MatchSnapshot {
  const top = (1 - bottom) as 0 | 1;
  const view = viewFor(state, bottom);
  view.players[top] = viewFor(state, top).players[top];
  return {
    matchId: log.matchId, phase: state.status === 'ended' ? 'ended' : 'active', mode: log.mode, seat: null,
    players: log.players.map((p) => ({ address: p.address, race: p.race, agent: p.agent })),
    view, legalActions: [], seq: 0, head: log.head, clock: null, eventCount: 0, result: log.result,
  };
}

function describeStep(frames: ReplayFrame[], i: number, races: [Race, Race]): string {
  const f = frames[i];
  const mv = f.move;
  if (!mv) return i === 0 ? 'Both seeds revealed, decks shuffled, opening hands drawn.' : 'A player ran out of time too often and forfeited.';
  const who = raceName(races[mv.seat]);
  const before = frames[i - 1].state.players[mv.seat];
  const nameOf = (uid: number) => {
    const c = before.hand.find((h) => h.uid === uid) ?? before.board.find((u) => u.uid === uid);
    return c ? card(c.cardId).name : 'a card';
  };
  const a = mv.action;
  const n = `${i}/${frames.length - 1}`;
  switch (a.type) {
    case 'play': return `${n} · ${who} played ${nameOf(a.uid)}${a.ape ? ' (aped)' : ''}`;
    case 'attack': {
      const target = a.target === 'treasury' ? 'the Treasury'
        : (() => { const u = frames[i - 1].state.players[1 - mv.seat].board.find((x) => x.uid === a.target); return u ? card(u.cardId).name : 'a unit'; })();
      return `${n} · ${who}: ${nameOf(a.attacker)} attacked ${target}`;
    }
    case 'endTurn': return `${n} · ${who} ${mv.signature ? 'ended the turn' : 'timed out (turn ended by the referee)'}`;
    case 'concede': return `${n} · ${who} conceded`;
    default: return n;
  }
}

function Verification({ log, checks }: { log: MatchLog; checks: ReturnType<typeof replayLog>['checks'] }) {
  const { contracts, explorer } = useHub();
  const sigs = useQuery({ queryKey: ['sigs', log.matchId], queryFn: () => verifyMoveSignatures(log), staleTime: Infinity });
  const { settled } = useSettled([log.matchId]);
  const onchain = settled.get(log.matchId);
  const s = sigs.data;
  const sigOk = s ? s.failed.length === 0 : undefined;
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `forkfall-${log.matchId.slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(url);
  };
  const rows: { ok: boolean | undefined; label: string; detail?: string }[] = [
    checks.seeds, checks.chain, checks.outcome,
    {
      ok: sigOk,
      label: s ? `${s.verified} of ${log.moves.length} moves signed by the player or their session key` : 'Checking move signatures…',
      detail: s ? [s.forced && `${s.forced} turn${s.forced > 1 ? 's' : ''} ended by the referee clock`, s.unchecked && `${s.unchecked} by a smart-wallet session key (needs a chain call to check)`, s.failed.length && `bad signature on move ${s.failed.join(', ')}`].filter(Boolean).join(' · ') || undefined : undefined,
    },
  ];
  return (
    <div className="verify">
      <h2 className="sub">Verified in your browser</h2>
      <ul>
        {rows.map((r) => (
          <li key={r.label} className={r.ok === undefined ? 'pending' : r.ok ? 'ok' : 'bad'}>
            <span aria-hidden>{r.ok === undefined ? '…' : r.ok ? '✓' : '✗'}</span>
            <div>{r.label}{r.detail && <div className="muted small">{r.detail}</div>}</div>
          </li>
        ))}
        {contracts && (
          <li className={onchain ? 'ok' : 'pending'}>
            <span aria-hidden>{onchain ? '✓' : '○'}</span>
            <div>{onchain ? 'Settled on MatchSettlement' : 'Not settled on-chain yet'}
              {explorer && <div className="small"><a href={`${explorer}/address/${contracts.MatchSettlement}`} target="_blank" rel="noreferrer">Contract on explorer ↗</a></div>}
            </div>
          </li>
        )}
      </ul>
      <p className="muted small mono">log hash {shortAddr(log.head)} · {log.moves.length} moves</p>
      <div className="row-end" style={{ marginTop: 8 }}>
        <Link className="btn btn-ghost" to="/matches">← Matches</Link>
        <button className="btn" onClick={download}>Download log</button>
      </div>
    </div>
  );
}
