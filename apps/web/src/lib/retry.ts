import { isRateLimited } from '@forkfall/sdk';

/**
 * Run a referee request again when it was refused for the rate limit (10 requests/s per session, burst 30). The
 * referee rejects such a request before acting on it, so sending it again is safe; the waits (350, 700, 1050 ms)
 * let the bucket refill. Any other error, or a fourth 429, goes to the caller.
 */
export async function retryRateLimited<T>(fn: () => Promise<T>, tries = 4, baseMs = 350): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimited(e) || i >= tries) throw e;
      await new Promise((r) => setTimeout(r, baseMs * i));
    }
  }
}
