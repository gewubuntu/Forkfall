import { card, type Rarity } from '@forkfall/engine';
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { GameCard } from './GameCard.tsx';
import { LOGO_MARK } from '../lib/art.ts';
import { useParticles } from '../lib/particles.ts';
import { isMuted, setMuted, sfx } from '../lib/sfx.ts';

const RARITY_LABEL: Record<Rarity, string> = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', legendary: 'Legendary!' };
const ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'legendary'];
const BURST: Record<Rarity, { colors: string[]; n: number; power: number }> = {
  common: { colors: ['#9aa3b5', '#cfd6e4'], n: 10, power: 4 },
  uncommon: { colors: ['#e2e8f0', '#94a3b8', '#ffffff'], n: 22, power: 5 },
  rare: { colors: ['#ffd56b', '#f59e0b', '#fff3c4'], n: 55, power: 8 },
  legendary: { colors: ['#ff7ad9', '#67e8f9', '#a3e635', '#fde68a', '#ffffff'], n: 160, power: 12 },
};

type Phase = 'sealed' | 'ready' | 'tearing' | 'dealt';

/**
 * Pack opening, in beats: the sealed pack wobbles while its transaction confirms, then glows in the colour of
 * its best card (rays for Rare and better). Click it to tear it open: the cards fly out face-down, Rare and
 * Legendary backs already shimmering, and you flip them one by one (or Reveal all). Rare flips burst in gold;
 * a Legendary flashes the screen, shakes the stage and sweeps a banner. Chiptune sounds, mutable.
 * With reduced motion the cards simply appear face-up.
 */
export function PackReveal({ ids, fresh, packId, onClose, next }: {
  /** null while the open transaction is confirming. */
  ids: number[] | null; fresh: boolean[]; packId?: bigint; onClose: () => void; next?: () => void;
}) {
  const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [phase, setPhase] = useState<Phase>(ids ? (reduced ? 'dealt' : 'ready') : 'sealed');
  const [flipped, setFlipped] = useState<boolean[]>(() => (ids ?? []).map(() => reduced));
  const [muted, setMute] = useState(isMuted());
  const [banner, setBanner] = useState(false);
  const [shake, setShake] = useState(false);
  const { ref: canvas, burst } = useParticles();
  const root = useRef<HTMLDivElement>(null);
  const packRef = useRef<HTMLButtonElement>(null);
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const best: Rarity = (ids ?? []).reduce<Rarity>((b, id) => (ORDER.indexOf(card(id).rarity) > ORDER.indexOf(b) ? card(id).rarity : b), 'common');
  // Every pack holds a Rare, so the pack itself only teases a Legendary (rays and pink glow).
  const tier = best === 'legendary' ? 3 : 1;
  const done = phase === 'dealt' && flipped.length > 0 && flipped.every(Boolean);

  // Transaction confirmed: the pack charges up in its best rarity's colour.
  useEffect(() => {
    if (!ids) { sfx.rumble(); return; }
    setFlipped(ids.map(() => reduced));
    if (reduced) { setPhase('dealt'); return; }
    setPhase('ready');
    sfx.charge(tier);
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps

  const center = (el: Element | null) => {
    const r = el?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: innerWidth / 2, y: innerHeight / 2 };
  };

  const tear = useCallback(() => {
    if (phase !== 'ready') return;
    setPhase('tearing');
    sfx.tear();
    const c = center(packRef.current);
    burst(c.x, c.y - 90, BURST[best].colors.concat('#ffffff'), 40 + tier * 20, 7);
    setTimeout(() => {
      setPhase('dealt');
      (ids ?? []).forEach((_, i) => setTimeout(() => sfx.deal(i), 90 * i));
    }, 520);
  }, [phase, best, tier, ids, burst]);

  const flip = useCallback((i: number) => {
    if (!ids || flipped[i]) return;
    setFlipped((f) => f.map((x, j) => (j === i ? true : x)));
    if (reduced) return;
    const r = card(ids[i]).rarity;
    sfx.flip(r);
    const c = center(cardRefs.current[i]);
    burst(c.x, c.y, BURST[r].colors, BURST[r].n, BURST[r].power);
    if (r === 'legendary') {
      setBanner(true); setShake(true);
      setTimeout(() => burst(c.x, c.y, BURST.legendary.colors, 90, 15), 260);
      setTimeout(() => setShake(false), 600);
      setTimeout(() => setBanner(false), 1900);
    } else if (r === 'rare') { setShake(true); setTimeout(() => setShake(false), 300); }
  }, [ids, flipped, reduced, burst]);

  const revealAll = () => { if (!ids) return; ids.forEach((_, i) => { if (!flipped[i]) setTimeout(() => flip(i), 140 * i); }); };

  useEffect(() => { if (done && !reduced) sfx.done(); }, [done, reduced]);
  useEffect(() => {
    if (phase === 'ready') packRef.current?.focus();
    if (done) root.current?.querySelector<HTMLButtonElement>('.reveal-actions .btn-primary')?.focus();
  }, [phase, done]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (phase !== 'sealed')) onClose();
      if (e.key === ' ' && phase === 'dealt' && !done) { e.preventDefault(); const i = flipped.indexOf(false); if (i >= 0) flip(i); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, phase, done, flipped, flip]);

  const title = phase === 'sealed' || phase === 'tearing' ? 'Opening…'
    : phase === 'ready' ? (best === 'legendary' ? 'Something’s glowing…' : 'Tear it open!')
    : !done ? 'Flip your cards'
    : best === 'legendary' ? 'Legendary pull!' : 'Pack opened';

  return (
    <div className={`modal-bg reveal-bg best-${phase === 'sealed' || best !== 'legendary' ? 'none' : best}`}>
      <canvas ref={canvas} className="particles" aria-hidden />
      {banner && <div className="legend-flash" aria-hidden />}
      {banner && <div className="legend-banner" aria-hidden><span>LEGENDARY</span></div>}
      <div className={`reveal ${shake ? 'shake' : ''}`} role="dialog" aria-modal="true" aria-label="Open pack" ref={root}>
        <button className="mute-btn" onClick={() => { setMuted(!muted); setMute(!muted); }} aria-label={muted ? 'Unmute sounds' : 'Mute sounds'} title={muted ? 'Sound off' : 'Sound on'}>
          {muted ? '🔇' : '🔊'}
        </button>
        <h2 className="reveal-title">{title}</h2>
        <p className="reveal-sub muted" aria-live="polite">
          {phase === 'sealed' ? `Pack${packId !== undefined ? ` #${String(packId)}` : ''}: confirm in your wallet, then the block decides your cards.`
            : phase === 'ready' ? 'Click the pack (or press Enter).'
            : phase === 'tearing' ? ' '
            : !done ? 'Click a card or press Space. Glowing backs hide the good stuff.' : ' '}
        </p>

        <div className="reveal-stage">
          {(phase === 'sealed' || phase === 'ready' || phase === 'tearing') && (
            <button ref={packRef} className={`pack3d tier-${phase === 'sealed' ? 'none' : tier} ${phase}`} onClick={tear} disabled={phase !== 'ready'}
              aria-label={phase === 'ready' ? 'Tear the pack open' : 'Sealed pack, waiting for confirmation'}>
              {phase !== 'sealed' && <span className="pack-rays" aria-hidden />}
              <span className="pk-top" aria-hidden />
              <span className="pk-body" aria-hidden><img src={LOGO_MARK} alt="" /><b>SET 1</b><small>5 cards</small></span>
            </button>
          )}
          {phase === 'dealt' && ids && (
            <div className="reveal-row">
              {ids.map((id, i) => {
                const c = card(id);
                return (
                  <button key={i} ref={(el) => { cardRefs.current[i] = el; }}
                    className={`flip deal ${flipped[i] ? 'on' : ''} r-${c.rarity}`}
                    style={{ ['--dx' as string]: `${(ids.length - 1) / 2 * 152 - i * 152}px`, ['--i' as string]: i } as CSSProperties}
                    onClick={() => flip(i)}
                    aria-label={flipped[i] ? `${c.name}, ${c.rarity}${fresh[i] ? ', new' : ''}` : 'Face-down card, reveal'}>
                    <span className="flip-inner">
                      <span className="flip-back" aria-hidden><img src={LOGO_MARK} alt="" /></span>
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
          )}
        </div>

        <div className="reveal-actions">
          {phase === 'dealt' && !done && <button className="btn" onClick={revealAll}>Reveal all</button>}
          {done && next && <button className="btn" onClick={next}>Open next pack</button>}
          {done && <button className="btn btn-primary" onClick={onClose}>Add to collection</button>}
        </div>
      </div>
    </div>
  );
}
