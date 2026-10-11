import { card } from '@forkfall/engine';
import { useEffect, useRef } from 'react';
import { KEYWORD_HELP, KEYWORD_LABEL, RACE_INFO } from '../game/meta.ts';
import { GameCard } from './GameCard.tsx';

/**
 * Full-size card with its keyword rules, over everything: opened by a long-press (or the ⓘ on a selected card) on
 * touch screens, where hovering for the sidebar preview isn't possible. A tap anywhere or Esc closes it.
 */
export function CardZoom({ cardId, onClose }: { cardId: number; onClose: () => void }) {
  const c = card(cardId);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const kws = c.keywords.filter((k) => KEYWORD_LABEL[k]);
  return (
    <div className="zoom-bg" onClick={onClose}>
      <div className="zoom" role="dialog" aria-modal="true" aria-label={`${c.name} details`}>
        <GameCard cardId={cardId} size="preview" />
        {(kws.length > 0 || c.faction) && (
          <div className="zoom-kw">
            {kws.map((k) => <p key={k}><b>{KEYWORD_LABEL[k]}</b> {KEYWORD_HELP[k]}</p>)}
            <p className="muted">{c.rarity} · {c.faction === 'neutral' ? 'Neutral' : `${RACE_INFO[c.faction].name} (${RACE_INFO[c.faction].chain})`}</p>
          </div>
        )}
        <button ref={closeRef} className="btn btn-block" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
