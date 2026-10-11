import { useEffect, useState } from 'react';

/** Live result of a CSS media query (false where matchMedia is missing). */
export function useMedia(query: string): boolean {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches;
  const [on, setOn] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const f = () => setOn(mq.matches);
    f();
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [query]);
  return on;
}

/** A finger is the main pointer (phones, tablets): taps arm a card first, long-press opens details. */
export const useTouch = () => useMedia('(pointer: coarse)');

/** Phone layout for the match board (portrait phones, and landscape phones with little height). Mirrors game.css. */
export const COMPACT_QUERY = '(max-width: 760px), (max-height: 500px) and (orientation: landscape)';
