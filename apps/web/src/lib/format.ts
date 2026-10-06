export const shortAddr = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

export function timeLeft(ms: number): string {
  if (ms <= 0) return 'expired';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/** Like timeLeft, but in days past two days ("13 days"), for waits measured in days. */
export const daysLeft = (ms: number) => (ms > 2 * 86_400_000 ? `${Math.floor(ms / 86_400_000)} days` : timeLeft(ms));

export function chainDotClass(chainId?: number): string {
  return chainId === 84532 ? 'base' : chainId === 46630 ? 'rh' : 'local';
}

/** "in 7 min" / "shortly" for a future timestamp. */
export function inTime(ts: number): string {
  const min = Math.ceil((ts - Date.now()) / 60000);
  return min <= 0 ? 'shortly' : `in ${min} min`;
}
