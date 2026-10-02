import { card, type UnitState } from '@forkfall/engine';
import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';
import { KEYWORD_LABEL, RACE_COLOR } from '../game/meta.ts';
import { spriteSvg } from '../lib/art.ts';

export interface GameCardProps {
  cardId: number;
  /** Board state: shows live attack/health instead of printed stats. */
  unit?: UnitState;
  /** Extra attack from Swarm, shown on top of the unit's attack. */
  bonusAttack?: number;
  /** Displayed cost (after discounts). */
  cost?: number;
  size?: 'hand' | 'board' | 'preview' | 'mini';
  playable?: boolean;
  selected?: boolean;
  targetable?: boolean;
  ready?: boolean;
  dimmed?: boolean;
  hit?: boolean;
  onClick?: () => void;
  onHover?: (cardId: number | null) => void;
  label?: string;
}

/**
 * Flat modern frame shared by every card, tinted per race; pixel art inside (GDD art direction).
 * Rarity shows in the frame material; the corner badge shows the chain of origin.
 */
export function GameCard(p: GameCardProps) {
  const c = card(p.cardId);
  const size = p.size ?? 'hand';
  const u = p.unit;
  const atk = u ? u.attack + (p.bonusAttack ?? 0) : c.attack;
  const hp = u ? u.health : c.health;
  const hurt = u ? u.health < u.maxHealth : false;
  const buffed = u ? u.attack > (c.attack ?? 0) || (p.bonusAttack ?? 0) > 0 : false;
  const kws = (u?.keywords ?? c.keywords).map((k) => KEYWORD_LABEL[k]).filter(Boolean);
  const chain = c.chain === 'base' ? 'BASE' : c.chain === 'robinhood' ? 'RH' : '';
  const cls = [
    'gcard', `gcard-${size}`, `r-${c.rarity}`, c.chain !== 'any' ? `ch-${c.chain}` : '',
    p.playable && 'is-playable', p.selected && 'is-selected', p.targetable && 'is-target',
    p.ready && 'is-ready', p.dimmed && 'is-dim', p.hit && 'is-hit', p.onClick && 'is-clickable',
  ].filter(Boolean).join(' ');
  const style = { ['--rc' as string]: RACE_COLOR[c.faction] } as CSSProperties;
  const interactive = !!p.onClick;
  const onKey = (e: KeyboardEvent) => { if (interactive && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); p.onClick!(); } };
  const onClick = (e: MouseEvent) => { e.stopPropagation(); p.onClick?.(); };

  return (
    <div
      className={cls}
      style={style}
      data-uid={u?.uid}
      data-card={u ? p.cardId : undefined}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={p.label ?? `${c.name}${u ? `, ${atk} attack, ${hp} health` : `, costs ${p.cost ?? c.cost}`}`}
      aria-pressed={interactive ? !!p.selected : undefined}
      onClick={interactive ? onClick : undefined}
      onKeyDown={onKey}
      onMouseEnter={() => p.onHover?.(p.cardId)}
      onMouseLeave={() => p.onHover?.(null)}
      onFocus={() => p.onHover?.(p.cardId)}
      onBlur={() => p.onHover?.(null)}
    >
      {!u && <span className={`gc-cost ${p.cost !== undefined && p.cost < c.cost ? 'cheaper' : ''}`}>{p.cost ?? c.cost}</span>}
      {chain && <span className="gc-chain">{chain}</span>}
      <div className="gc-art"><img src={spriteSvg(p.cardId)} alt="" draggable={false} /></div>
      <div className="gc-name">{c.name}</div>
      {size !== 'board' && size !== 'mini' && <div className="gc-text">{c.text}</div>}
      {(size === 'board' || size === 'mini') && kws.length > 0 && <div className="gc-kw">{kws.join(' · ')}</div>}
      {c.type === 'unit' ? (
        <div className="gc-stats">
          <span className={`gc-atk ${buffed ? 'up' : ''}`}>{atk}</span>
          <span className={`gc-hp ${hurt ? 'down' : ''}`}>{hp}</span>
        </div>
      ) : (
        <div className="gc-type">{c.type}</div>
      )}
      {p.ready && <span className="gc-ready">READY</span>}
    </div>
  );
}

/** Face-down card back for hidden hands and decks. */
export function CardBack({ small }: { small?: boolean }) {
  return <div className={`gcard-back ${small ? 'small' : ''}`} aria-hidden />;
}
