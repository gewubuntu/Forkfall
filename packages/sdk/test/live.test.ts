import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { LiveClient } from '../src/index.ts';

/** A localhost port nothing listens on: connecting to it fails at once. */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as { port: number };
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('LiveClient', () => {
  it('survives a referee it can’t reach: no crash, it reports down and keeps retrying', async () => {
    const crashes: unknown[] = [];
    const onCrash = (e: unknown) => { crashes.push(e); };
    process.on('uncaughtException', onCrash);
    const statuses: boolean[] = [];
    const port = await deadPort();
    const live = new LiveClient(`ws://127.0.0.1:${port}/v1/live`, { maxBackoffMs: 50, onStatus: (up) => statuses.push(up) });
    const listener = createServer((sock) => { attempts++; sock.destroy(); });
    let attempts = 0;
    try {
      await new Promise((r) => setTimeout(r, 400)); // several failed attempts
      expect(crashes).toEqual([]);
      expect(live.connected).toBe(false);
      expect(statuses).not.toContain(true);
      // Something comes up on the port: the client is still trying to reach it.
      await new Promise<void>((r) => listener.listen(port, '127.0.0.1', () => r()));
      const end = Date.now() + 2000;
      while (attempts === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      expect(attempts).toBeGreaterThan(0);
      expect(crashes).toEqual([]);
    } finally {
      live.close();
      listener.close();
      process.off('uncaughtException', onCrash);
    }
  });
});

describe('LiveClient.close()', () => {
  it('while still connecting neither crashes nor reconnects', async () => {
    const crashes: unknown[] = [];
    const onCrash = (e: unknown) => { crashes.push(e); };
    process.on('uncaughtException', onCrash);
    const port = await deadPort();
    let attempts = 0;
    const listener = createServer((sock) => { attempts++; sock.destroy(); });
    try {
      const live = new LiveClient(`ws://127.0.0.1:${port}/v1/live`, { maxBackoffMs: 50 });
      live.close(); // in Node, this fired 'error' inside close() and recursed too
      await new Promise<void>((r) => listener.listen(port, '127.0.0.1', () => r()));
      await new Promise((r) => setTimeout(r, 300));
      expect(crashes).toEqual([]);
      expect(attempts).toBe(0); // closed means closed
    } finally {
      listener.close();
      process.off('uncaughtException', onCrash);
    }
  });
});
