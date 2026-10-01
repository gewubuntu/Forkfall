import type { Action, GameEvent } from '@forkfall/engine';
import type { ForkfallClient, MatchSnapshot } from '@forkfall/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Hex } from 'viem';

export interface LogLine { id: number; text: string; event: GameEvent }

export interface MatchHook {
  snap: MatchSnapshot | null;
  events: GameEvent[];
  error: string | null;
  notFound: boolean;
  sending: boolean;
  /** Unit uids (and 'treasury-0'/'treasury-1') that took damage in the latest update. */
  hits: Set<string>;
  send: (a: Action) => Promise<boolean>;
  clearError: () => void;
}

const POLL_MS = 700;

/**
 * Live match state: polls the referee (no websockets yet), reveals the seed when the match starts,
 * submits session-key-signed moves and collects the event stream visible to this seat.
 */
export function useMatch(client: ForkfallClient | null, matchId: Hex): MatchHook {
  const [snap, setSnap] = useState<MatchSnapshot | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [sending, setSending] = useState(false);
  const [hits, setHits] = useState<Set<string>>(new Set());
  const cursor = useRef(0);
  const revealed = useRef(false);
  const sendingRef = useRef(false);
  const hitTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const ingest = useCallback((evs: GameEvent[]) => {
    if (!evs.length) return;
    setEvents((old) => [...old, ...evs]);
    const hit = new Set<string>();
    for (const e of evs) if (e.t === 'damage') hit.add(e.uid === 'treasury' ? `treasury-${e.seat}` : String(e.uid));
    if (hit.size) {
      setHits(hit);
      clearTimeout(hitTimer.current);
      hitTimer.current = setTimeout(() => setHits(new Set()), 650);
    }
  }, []);

  const pullEvents = useCallback(async () => {
    if (!client) return;
    const r = await client.events(matchId, cursor.current);
    cursor.current = r.next;
    ingest(r.events);
  }, [client, matchId, ingest]);

  const refresh = useCallback(async () => {
    if (!client || sendingRef.current) return;
    try {
      let s = await client.state(matchId);
      if (s.phase === 'reveal' && s.seat !== null && !revealed.current) {
        revealed.current = true;
        await client.reveal(matchId).catch((e) => {
          if (!String(e).includes('already revealed')) setError(`Could not reveal your seed: ${(e as Error).message}`);
        });
        s = await client.state(matchId);
      }
      setSnap(s);
      await pullEvents();
    } catch (e) {
      const msg = String((e as Error).message);
      if (msg.includes('404')) setNotFound(true);
      else if (!msg.includes('429')) setError(msg.replace(/^.*?→ \d+: /, ''));
    }
  }, [client, matchId, pullEvents]);

  useEffect(() => {
    cursor.current = 0;
    revealed.current = false;
    setEvents([]); setSnap(null); setNotFound(false);
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const send = useCallback(async (a: Action) => {
    if (!client || !snap || sendingRef.current) return false;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      const next = await client.move(matchId, snap, a);
      setSnap(next);
      await pullEvents();
      return true;
    } catch (e) {
      setError(String((e as Error).message).replace(/^.*?→ \d+: /, ''));
      // Stale view (e.g. a timeout ended the turn): resync.
      sendingRef.current = false;
      await refresh();
      return false;
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [client, snap, matchId, pullEvents, refresh]);

  return { snap, events, error, notFound, sending, hits, send, clearError: () => setError(null) };
}
