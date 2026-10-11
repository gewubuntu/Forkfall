import { useEffect, useRef, type RefObject } from 'react';

/** What a drag picked up: a card in your hand, or one of your units on the board. */
export type DragSource = { kind: 'hand'; uid: number } | { kind: 'unit'; uid: number };
/** Where it was let go: a unit (either side), a Treasury, your own half of the board, or nowhere useful. */
export type DropTarget = { kind: 'unit'; uid: number } | { kind: 'treasury'; side: 0 | 1 } | { kind: 'board' } | null;

export interface GestureHandlers {
  /** Long-press (touch or pen): show the card's details. Never plays anything. */
  onZoom: (cardId: number) => void;
  /** Whether this source may be dragged right now (your turn, a legal move exists). */
  canDrag: (src: DragSource) => boolean;
  onDragStart?: (src: DragSource) => void;
  onDrop: (src: DragSource, target: DropTarget) => void;
  onDragEnd?: () => void;
}

/** Hold this long without moving to open the details. */
export const LONG_PRESS_MS = 420;
/** A finger wobbles: below this many px it's still a tap or a press. */
export const DRAG_SLOP_PX = 10;

/**
 * Classify a pointer gesture from how far it moved and how long it was held. A press that moved past the slop is a
 * drag (and cancels the long-press timer), one held still for LONG_PRESS_MS is a long-press, anything else a tap.
 */
export function classifyGesture(dx: number, dy: number, heldMs: number, pointerType: string): 'drag' | 'long' | 'tap' {
  if (Math.hypot(dx, dy) > DRAG_SLOP_PX) return 'drag';
  if (pointerType !== 'mouse' && heldMs >= LONG_PRESS_MS) return 'long';
  return 'tap';
}

/**
 * Read the drop target under a point from the data attributes the board renders. Letting go over your hand is a
 * cancel (null), not a play: dragging a card out and back is how a player changes their mind.
 */
export function targetFromElement(el: Element | null): DropTarget {
  if (!el || el.closest('.hand')) return null;
  const unit = el.closest<HTMLElement>('[data-uid]');
  if (unit?.dataset.uid) return { kind: 'unit', uid: Number(unit.dataset.uid) };
  const t = el.closest<HTMLElement>('[data-treasury]');
  if (t?.dataset.treasury) return { kind: 'treasury', side: Number(t.dataset.treasury) as 0 | 1 };
  if (el.closest('.side.me')) return { kind: 'board' };
  return null;
}

function sourceFromElement(el: HTMLElement): DragSource | null {
  if (el.dataset.hand) return { kind: 'hand', uid: Number(el.dataset.hand) };
  if (el.dataset.uid && el.closest('.side.me')) return { kind: 'unit', uid: Number(el.dataset.uid) };
  return null;
}

/**
 * Pointer Events for the board (mouse, touch and pen alike): drag a hand card onto the board or a target, drag a
 * ready unit onto an enemy, long-press any card for its details. Taps fall through to the cards' own click handlers,
 * so tap-to-select / tap-to-play keeps working. A click that ends a drag or long-press is swallowed, so neither
 * ever plays a card by accident.
 */
export function useBoardGestures(root: RefObject<HTMLElement | null>, handlers: GestureHandlers) {
  const h = useRef(handlers);
  h.current = handlers;

  useEffect(() => {
    // Listens on the document, so a board that mounts after a loading screen is covered too.
    let g: {
      id: number; x0: number; y0: number; t0: number; type: string; card: HTMLElement; cardId: number;
      src: DragSource | null; timer?: ReturnType<typeof setTimeout>; long: boolean;
      ghost?: HTMLElement; ox: number; oy: number; hover?: Element | null;
    } | null = null;

    const swallowClick = () => {
      const stop = (e: Event) => { e.stopPropagation(); e.preventDefault(); };
      window.addEventListener('click', stop, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 400);
    };
    const setHover = (next: Element | null) => {
      if (!g || g.hover === next) return;
      g.hover?.classList.remove('drop-hover');
      next?.classList.add('drop-hover');
      g.hover = next;
    };
    const end = () => {
      if (!g) return;
      clearTimeout(g.timer);
      setHover(null);
      g.ghost?.remove();
      g.card.classList.remove('is-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      g = null;
    };

    const down = (e: PointerEvent) => {
      if (g || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const card = (e.target as Element).closest<HTMLElement>('[data-zoom]');
      if (!card || !root.current?.contains(card)) return;
      const r = card.getBoundingClientRect();
      g = {
        id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), type: e.pointerType, card,
        cardId: Number(card.dataset.zoom), src: sourceFromElement(card), long: false, ox: e.clientX - r.left, oy: e.clientY - r.top,
      };
      if (e.pointerType !== 'mouse') {
        g.timer = setTimeout(() => {
          if (!g || g.ghost) return;
          g.long = true;
          navigator.vibrate?.(8);
          h.current.onZoom(g.cardId);
        }, LONG_PRESS_MS);
      }
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
    };

    const move = (e: PointerEvent) => {
      if (!g || e.pointerId !== g.id || g.long) return;
      const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      if (!g.ghost) {
        if (classifyGesture(dx, dy, 0, g.type) !== 'drag') return;
        clearTimeout(g.timer);
        if (!g.src || !h.current.canDrag(g.src)) { end(); return; }
        const r = g.card.getBoundingClientRect();
        const ghost = g.card.cloneNode(true) as HTMLElement;
        ghost.removeAttribute('data-uid'); ghost.removeAttribute('data-hand'); ghost.removeAttribute('data-zoom');
        ghost.classList.add('drag-ghost');
        ghost.setAttribute('aria-hidden', 'true');
        Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px` });
        document.body.append(ghost);
        g.ghost = ghost;
        g.card.classList.add('is-dragging');
        h.current.onDragStart?.(g.src);
      }
      e.preventDefault();
      g.ghost.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(${Math.max(-8, Math.min(8, dx / 20))}deg)`;
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const t = targetFromElement(under);
      setHover(t?.kind === 'unit' ? under!.closest('[data-uid]') : t?.kind === 'treasury' ? under!.closest('[data-treasury]') : t?.kind === 'board' ? under!.closest('.side.me') : null);
    };

    const up = (e: PointerEvent) => {
      if (!g || e.pointerId !== g.id) return;
      const { ghost, src, long } = g;
      if (ghost && src) {
        const t = targetFromElement(document.elementFromPoint(e.clientX, e.clientY));
        end();
        swallowClick();
        h.current.onDrop(src, t);
        h.current.onDragEnd?.();
        return;
      }
      end();
      if (long) swallowClick();
    };
    const cancel = (e: PointerEvent) => {
      if (!g || e.pointerId !== g.id) return;
      const dragging = !!g.ghost;
      end();
      if (dragging) h.current.onDragEnd?.();
    };
    // A long-press on Android/iOS would open the browser's image/context menu over the card.
    const menu = (e: Event) => { const c = (e.target as Element).closest?.('[data-zoom]'); if (c && root.current?.contains(c)) e.preventDefault(); };

    document.addEventListener('pointerdown', down);
    document.addEventListener('contextmenu', menu);
    return () => {
      end();
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('contextmenu', menu);
    };
  }, [root]);
}
