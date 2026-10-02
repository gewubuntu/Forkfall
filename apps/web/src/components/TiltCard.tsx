import { useRef, type ReactNode } from 'react';

/**
 * Wraps a card so it tilts toward the pointer and catches the light: a soft glare follows the cursor,
 * and Rare and Legendary cards get a holographic rainbow sheen. Pure CSS variables, no re-renders.
 * Reduced motion keeps the card flat.
 */
export function TiltCard({ rarity, children, strength = 12, className = '' }: {
  rarity: string; children: ReactNode; strength?: number; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const move = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el || reduced) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    el.style.setProperty('--rx', `${(0.5 - py) * strength}deg`);
    el.style.setProperty('--ry', `${(px - 0.5) * strength}deg`);
    el.style.setProperty('--mx', `${px * 100}%`);
    el.style.setProperty('--my', `${py * 100}%`);
    el.classList.add('tilting');
  };
  const leave = () => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--rx', '0deg'); el.style.setProperty('--ry', '0deg');
    el.classList.remove('tilting');
  };
  return (
    <div ref={ref} className={`tilt r-${rarity} ${className}`} onPointerMove={move} onPointerLeave={leave}>
      <div className="tilt-inner">
        {children}
        <span className="tilt-glare" aria-hidden />
        {(rarity === 'rare' || rarity === 'legendary') && <span className="tilt-holo" aria-hidden />}
      </div>
    </div>
  );
}
