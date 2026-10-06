import { REFERRAL_DAYS, REFERRAL_MATCHES } from '@forkfall/engine';
import { isAddress, type Address } from 'viem';

/** Who invited this browser (from an invite link's `?ref=`), kept until the next sign-in or for 30 days. */
const KEY = 'ff.ref';
const KEEP_MS = 30 * 86_400_000;

/** Your invite link: anyone who signs in through it for the first time counts as your referral. */
export const inviteLink = (address: string) => `${location.origin}/?ref=${address}`;

/** Remember `?ref=` from the address bar (then drop it from the URL, so a shared link isn't re-shared with it). */
export function captureRef() {
  try {
    const url = new URL(location.href);
    const ref = url.searchParams.get('ref');
    if (!ref) return;
    if (isAddress(ref)) localStorage.setItem(KEY, JSON.stringify({ ref, at: Date.now() }));
    url.searchParams.delete('ref');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  } catch { /* storage blocked: the invite just isn't remembered */ }
}

/** The stored inviter, if any and still fresh. */
export function pendingRef(): Address | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { ref?: string; at?: number } | null;
    if (!v?.ref || !isAddress(v.ref) || Date.now() - (v.at ?? 0) > KEEP_MS) return undefined;
    return v.ref as Address;
  } catch { return undefined; }
}

export function clearRef() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

/** What an invited player gets, in one line. */
export const inviteTerms = `Verify and finish ${REFERRAL_MATCHES} matches against other players within ${REFERRAL_DAYS} days: you both get a free Set 1 pack.`;
