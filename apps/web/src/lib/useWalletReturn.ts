import { useEffect, useState } from 'react';

/**
 * True once the player left this page (to a wallet app, typically) and came back while a wallet request is still
 * pending. On phones that usually means the request was dismissed in the wallet, or its answer is still on the way,
 * so the UI can say so and offer to try again instead of spinning forever.
 */
export function useReturnedWhilePending(pending: boolean): boolean {
  const [back, setBack] = useState(false);
  useEffect(() => {
    setBack(false);
    if (!pending) return;
    let left = document.visibilityState === 'hidden';
    const f = () => {
      if (document.visibilityState === 'hidden') left = true;
      else if (left) setBack(true);
    };
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, [pending]);
  return back;
}
