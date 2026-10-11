/**
 * After a deploy, an open tab still points at the old build: the first visit to a page it hasn't loaded yet asks for
 * a chunk the server no longer has (404). The fix is a reload, which picks up the new build, but only once per
 * minute, so a chunk that is really broken shows an error instead of reloading forever.
 */
const KEY = 'ff.chunkReloadAt';

/** A failed dynamic import (Chromium, Firefox and Safari word it differently) or Vite's preload error. */
export const isChunkLoadError = (e: unknown): boolean =>
  /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(String((e as Error)?.message ?? e));

/** Whether to reload now; records the attempt. Without storage (private mode, blocked) it never reloads. */
export function claimReload(storage: Pick<Storage, 'getItem' | 'setItem'> | null, now = Date.now()): boolean {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(KEY)) || 0;
    if (now - last < 60_000) return false;
    storage.setItem(KEY, String(now));
    return true;
  } catch { return false; }
}

const session = () => { try { return window.sessionStorage; } catch { return null; } };

/** Reload once for a stale build; returns false when it won't (already tried in the last minute). */
export function reloadForNewBuild(): boolean {
  if (!claimReload(session())) return false;
  window.location.reload();
  return true;
}
