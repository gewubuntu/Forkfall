import { card, type GameEvent } from '@forkfall/engine';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GameCard } from '../components/GameCard.tsx';
import { useParticles } from '../lib/particles.ts';
import { sfx } from '../lib/sfx.ts';

/** Where a board unit was last seen on screen (page coordinates) and its element, kept after it unmounts. */
interface Seen { x: number; y: number; w: number; h: number; el: HTMLElement; cardId: number }

const RACE_FX: Record<string, string[]> = {
  agents: ['#22d3ee', '#a5f3fc', '#e2e8f0'], prophets: ['#8b7cff', '#fde68a', '#c4b5fd'],
  brokers: ['#22c55e', '#f0d78a', '#bbf7d0'], degens: ['#ff4fa8', '#b6f23c', '#fef08a'],
  neutral: ['#cfd6e4', '#9aa3b5', '#ffffff'],
};

/**
 * Match "juice", driven purely by the event stream so humans and agents see the same story:
 * attack lunges, damage numbers, units shattering into pixels, buff sparkles, spell casts shown big,
 * prediction call-outs, a turn banner and victory confetti. Each batch of events plays as a short
 * timeline (attack → impact → deaths). Mount animations for new units and hand cards live in CSS.
 * The first batch (history when joining) is skipped. Reduced motion keeps only the floating numbers.
 */
export function FxLayer({ events, seat, arena, races, skip }: {
  events: GameEvent[]; seat: 0 | 1 | null; arena: React.RefObject<HTMLDivElement | null>; races: [string, string];
  /** Replay: the latest change was a jump or a step back, so don't animate it. */
  skip?: boolean;
}) {
  const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const { ref: canvas, burst } = useParticles();
  const layer = useRef<HTMLDivElement>(null);
  const seen = useRef(new Map<number, Seen>());
  const processed = useRef(-1);
  const [cast, setCast] = useState<{ id: number; cardId: number; mine: boolean } | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Remember where every unit is drawn, after each render; entries outlive the element so deaths can be animated.
  useLayoutEffect(() => {
    for (const el of document.querySelectorAll<HTMLElement>('.match [data-uid]')) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      seen.current.set(Number(el.dataset.uid), { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, el, cardId: Number(el.dataset.card) });
    }
  });
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useEffect(() => {
    if (processed.current === -1 || skip || events.length < processed.current) {
      if (events.length || processed.current !== -1) processed.current = events.length;
      return;
    }
    const batch = events.slice(processed.current);
    processed.current = events.length;
    if (batch.length) play(batch);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const at = (ms: number, f: () => void) => { timers.current.push(setTimeout(f, ms)); };
  const unitEl = (uid: number) => document.querySelector<HTMLElement>(`.match [data-uid="${uid}"]`);
  const treasuryEl = (side: number) => document.querySelector<HTMLElement>(`.match [data-treasury="${side}"]`);
  const box = (el: HTMLElement | null, uid?: number) => {
    if (el?.isConnected) { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; }
    const s = uid !== undefined ? seen.current.get(uid) : undefined;
    return s ? { x: s.x - scrollX + s.w / 2, y: s.y - scrollY + s.h / 2, w: s.w, h: s.h } : null;
  };
  const targetBox = (seatOf: number, uid: number | 'treasury') => (uid === 'treasury' ? box(treasuryEl(seatOf)) : box(unitEl(uid), uid));

  function float(x: number, y: number, text: string, cls: string) {
    const el = document.createElement('span');
    el.className = `fx-float ${cls}`;
    el.textContent = text;
    el.style.left = `${x}px`; el.style.top = `${y}px`;
    layer.current?.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }

  function banner(text: string, mine: boolean) {
    const el = document.createElement('div');
    el.className = `fx-banner ${mine ? 'mine' : 'theirs'}`;
    el.innerHTML = `<span>${text}</span>`;
    layer.current?.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }

  function shake(strength: number) {
    arena.current?.animate(
      [{ transform: 'none' }, { transform: `translate(${-strength}px, ${strength / 2}px)` }, { transform: `translate(${strength}px, ${-strength / 2}px)` }, { transform: `translate(${-strength / 2}px, 0)` }, { transform: 'none' }],
      { duration: 320, easing: 'ease-out' },
    );
  }

  /** A detached copy of a unit that has left the board (or is about to), placed where it was last seen. */
  function ghost(uid: number): HTMLElement | null {
    const s = seen.current.get(uid);
    if (!s || !layer.current) return null;
    const g = s.el.cloneNode(true) as HTMLElement;
    g.classList.add('fx-ghost');
    g.removeAttribute('data-uid');
    Object.assign(g.style, { left: `${s.x - scrollX}px`, top: `${s.y - scrollY}px`, width: `${s.w}px`, height: `${s.h}px` });
    layer.current.appendChild(g);
    return g;
  }

  function lunge(attackerUid: number, targetSeat: number, target: number | 'treasury') {
    const from = box(unitEl(attackerUid), attackerUid);
    const to = targetBox(targetSeat, target);
    if (!from || !to) return;
    const live = unitEl(attackerUid);
    const el = live ?? ghost(attackerUid);
    if (!el) return;
    const dx = (to.x - from.x) * 0.72, dy = (to.y - from.y) * 0.72;
    el.style.zIndex = '20';
    const a = el.animate([
      { transform: 'translate(0, 0) scale(1)' },
      { transform: `translate(${-dx * 0.08}px, ${-dy * 0.08}px) scale(1.06)`, offset: 0.25 },
      { transform: `translate(${dx}px, ${dy}px) scale(1.08) rotate(${dx > 0 ? 6 : -6}deg)`, offset: 0.55 },
      { transform: 'translate(0, 0) scale(1)' },
    ], { duration: 420, easing: 'cubic-bezier(.3,.7,.3,1)' });
    a.onfinish = () => { el.style.zIndex = ''; if (!live) el.remove(); };
  }

  function shatter(uid: number, side: number) {
    const g = ghost(uid);
    const b = box(null, uid);
    if (b) burst(b.x, b.y, RACE_FX[card(seen.current.get(uid)?.cardId ?? 34).faction] ?? RACE_FX.neutral, 70, 6);
    if (g) {
      const a = g.animate([
        { transform: 'scale(1) rotate(0)', opacity: 1, filter: 'brightness(1)' },
        { transform: 'scale(1.05) rotate(-2deg)', opacity: 1, filter: 'brightness(2.2)', offset: 0.2 },
        { transform: `scale(.6) rotate(${side ? 8 : -8}deg) translateY(18px)`, opacity: 0, filter: 'brightness(1)' },
      ], { duration: 520, easing: 'ease-in' });
      a.onfinish = () => g.remove();
    }
    seen.current.delete(uid);
  }

  function play(batch: GameEvent[]) {
    let t = 0, impact = 0;
    for (const e of batch) {
      switch (e.t) {
        case 'turnStart': {
          const mine = seat !== null && e.seat === seat;
          at(t, () => { if (!reduced) banner(seat === null ? `${races[e.seat]} to move` : mine ? 'Your turn' : 'Opponent’s turn', mine); if (mine) sfx.turn(); });
          t += 150;
          break;
        }
        case 'play': {
          const c = card(e.cardId);
          at(t, () => { sfx.play(); if (c.type !== 'unit' && !reduced) setCast({ id: Date.now() + Math.random(), cardId: e.cardId, mine: e.seat === seat }); });
          t += c.type === 'unit' ? 120 : 520;
          break;
        }
        case 'summon':
          at(t + 60, () => {
            sfx.summon();
            const b = box(unitEl(e.uid), e.uid);
            if (b && !reduced) burst(b.x, b.y + b.h / 2 - 4, ['#cbd5e1', '#94a3b8', '#e2e8f0'], 16, 3.5);
          });
          t += 140;
          break;
        case 'attack': {
          const targetSeat = 1 - e.seat;
          at(t, () => { sfx.attack(); if (!reduced) lunge(e.attacker, targetSeat, e.target); });
          impact = t + 230;
          t += 440;
          break;
        }
        case 'damage': {
          const when = Math.max(impact, t - 380);
          at(when, () => {
            const b = targetBox(e.seat, e.uid);
            if (!b) return;
            sfx.hit(e.n);
            float(b.x, b.y - (e.uid === 'treasury' ? 10 : 20), `−${e.n}`, e.uid === 'treasury' ? 'dmg big' : 'dmg');
            if (!reduced) {
              burst(b.x, b.y, ['#ff4d64', '#ffb3be', '#ffffff'], 8 + e.n * 3, 4 + e.n * 0.4);
              if (e.uid === 'treasury' && e.n >= 4) shake(Math.min(10, 2 + e.n));
            }
          });
          t += 40;
          break;
        }
        case 'stat':
          at(t, () => {
            const b = box(unitEl(e.uid), e.uid);
            if (!b) return;
            sfx.buff();
            float(b.x, b.y - 26, `${e.attack}/${e.health}`, 'buff');
            if (!reduced) burst(b.x, b.y, ['#b6f23c', '#fde68a', '#ffffff'], 14, 3);
          });
          t += 90;
          break;
        case 'hold':
          at(t, () => { const b = box(unitEl(e.uid), e.uid); if (b) float(b.x, b.y - 26, '+1/+1 Hold', 'buff'); });
          t += 60;
          break;
        case 'death': {
          const when = Math.max(t, impact + 160);
          const side = e.seat;
          at(when, () => { sfx.death(); if (reduced) { seen.current.delete(e.uid); return; } shatter(e.uid, side); });
          t = when + 120;
          break;
        }
        case 'predictionResolved':
          at(t, () => {
            sfx.predict(e.hit);
            const b = box(treasuryEl(e.seat));
            if (b) float(b.x, b.y - 30, e.hit ? '◆ Called it!' : '◆ Backfired', e.hit ? 'pred hit' : 'pred miss');
          });
          t += 450;
          break;
        case 'apeDownside':
          at(t, () => { const b = box(treasuryEl(e.seat)); if (b) float(b.x, b.y - 30, 'Ape downside!', 'pred miss'); });
          t += 200;
          break;
        case 'burn':
          at(t, () => { const b = box(treasuryEl(e.seat)); if (b) float(b.x + 60, b.y, `${card(e.cardId).name} burned`, 'muted'); });
          break;
        case 'gameOver': {
          const won = seat !== null && e.winner === seat;
          at(t + 300, () => {
            if (seat === null || e.winner === 'draw') return;
            if (won) {
              sfx.win();
              if (!reduced) for (let i = 0; i < 5; i++) at(i * 180, () => burst(innerWidth * (0.2 + 0.15 * i), innerHeight * 0.35, ['#ff7ad9', '#67e8f9', '#b6f23c', '#fde68a', '#ffffff'], 70, 11));
            } else sfx.lose();
          });
          break;
        }
        default: break;
      }
    }
  }

  return (
    <>
      <canvas ref={canvas} className="particles fx-canvas" aria-hidden />
      <div ref={layer} className="fx-layer" aria-hidden />
      {cast && (
        <div key={cast.id} className={`fx-cast ${cast.mine ? 'mine' : 'theirs'}`} aria-hidden onAnimationEnd={() => setCast(null)}>
          <GameCard cardId={cast.cardId} size="preview" />
        </div>
      )}
    </>
  );
}
