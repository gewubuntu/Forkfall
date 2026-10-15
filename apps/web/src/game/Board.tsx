import { card, cosmetic, PREDICTION_LABELS, type GameEvent, type Race } from '@forkfall/engine';
import type { MatchSnapshot } from '@forkfall/sdk';
import { useEffect, useMemo, useRef } from 'react';
import { CardBack, GameCard } from '../components/GameCard.tsx';
import { avatarSvg } from '../lib/art.ts';
import { emblem } from '../lib/cosmetics.ts';
import { shortAddr } from '../lib/format.ts';
import { describeEvent, KEYWORD_HELP, KEYWORD_LABEL, RACE_INFO, raceName } from './meta.ts';

/*
 * Board pieces shared by the live match, replays and lessons. Kept free of wallet and auth code, so a lesson page
 * can show a board without loading the wallet stack (lesson.html).
 */

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
