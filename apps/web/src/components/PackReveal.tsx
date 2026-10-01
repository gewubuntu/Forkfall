import { card } from '@forkfall/engine';
import { useEffect, useRef, useState } from 'react';
import { GameCard } from './GameCard.tsx';

const RARITY_LABEL = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', legendary: 'Legendary!' } as const;

/** Five face-down cards that flip one by one; click a card (or Reveal all) to flip early. */
export function PackReveal({ ids, fresh, onClose, next }: {
  ids: number[]; fresh: boolean[]; onClose: () => void; next?: () => void;
}) {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [flipped, setFlipped] = useState<boolean[]>(() => ids.map(() => !!reduced));
  const ref = useRef<HTMLDivElement>(null);
  const done = flipped.every(Boolean);
  const best = ids.reduce((b, id) => {
    const order = ['common', 'uncommon', 'rare', 'legendary'];
    return order.indexOf(card(id).rarity) > order.indexOf(b) ? card(id).rarity : b;
  }, 'common' as ReturnType<typeof card>['rarity']);

  useEffect(() => {
    if (reduced) return;
    const timers = ids.map((_, i) => setTimeout(() => setFlipped((f) => f.map((x, j) => (j === i ? true : x))), 500 + i * 420));
    return () => timers.forEach(clearTimeout);
  }, [ids, reduced]);

  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('.reveal-actions .btn')?.focus(); }, [done]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={`modal-bg reveal-bg best-${best}`}>
      <div className="reveal" role="dialog" aria-modal="true" aria-label="Pack opened" ref={ref}>
        <h2 className="reveal-title">{done ? (best === 'legendary' ? 'Legendary pull!' : 'Pack opened') : 'Opening…'}</h2>
        <div className="reveal-row">
          {ids.map((id, i) => {
            const c = card(id);
            return (
              <button key={i} className={`flip ${flipped[i] ? 'on' : ''} r-${c.rarity}`} style={{ transitionDelay: '0ms' }}
                onClick={() => setFlipped((f) => f.map((x, j) => (j === i ? true : x)))}
                aria-label={flipped[i] ? `${c.name}, ${c.rarity}${fresh[i] ? ', new' : ''}` : 'Face-down card, reveal'}>
                <span className="flip-inner">
                  <span className="flip-back" aria-hidden><span className="pack-sigil" /></span>
                  <span className="flip-front">
                    <GameCard cardId={id} size="hand" />
                    {fresh[i] && <span className="new-badge">NEW</span>}
                    <span className="rarity-tag">{RARITY_LABEL[c.rarity]}</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="reveal-actions">
          {!done && <button className="btn" onClick={() => setFlipped(ids.map(() => true))}>Reveal all</button>}
          {done && next && <button className="btn" onClick={next}>Open next pack</button>}
          {done && <button className="btn btn-primary" onClick={onClose}>Add to collection</button>}
        </div>
      </div>
    </div>
  );
}
