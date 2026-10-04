import type { Action, GameEvent } from '@forkfall/engine';
import type { ForkfallClient, MatchSnapshot } from '@forkfall/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Hex } from 'viem';
import { useLiveTopic } from '../lib/live.ts';

export interface LogLine { id: number; text: string; event: GameEvent }

export interface MatchHook {
  snap: MatchSnapshot | null;
  events: GameEvent[];
  error: string | null;
  notFound: boolean;
  /** The referee can't be reached (e.g. restarting): retrying on its own; the match is saved server-side. */
  offline: boolean;
  sending: boolean;
  /** Unit uids (and 'treasury-0'/'treasury-1') that took damage in the latest update. */
  hits: Set<string>;
  send: (a: Action) => Promise<boolean>;
  clearError: () => void;
}

const POLL_MS = 700;

/** fetch() failed to reach the server at all (browsers: TypeError "Failed to fetch" / "NetworkError…"). */
const isNetworkError = (e: unknown) => e instanceof TypeError || /failed to fetch|networkerror|fetch failed|load failed/i.test(String((e as Error)?.message));
/** While the live socket is up, moves arrive as pushes; this slow poll is only a safety net. */
const SAFETY_POLL_MS = 10_000;

/**
 * Live match state: refreshes when the referee pushes a notice for this match (WebSocket), with a slow safety
 * poll (or the old 700 ms poll while the socket is down); reveals the seed when the match starts, submits
 * session-key-signed moves and collects the event stream visible to this seat.
 */
export function useMatch(client: ForkfallClient | null, matchId: Hex): MatchHook {
  const [snap, setSnap] = useState<MatchSnapshot | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [offline, setOffline] = useState(false);
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

  const matchRef = useRef(matchId);
  matchRef.current = matchId;

  const pullEvents = useCallback(async (): Promise<void> => {
    if (!client) return;
    const from = cursor.current;
    const r = await client.events(matchId, from);
    if (matchId !== matchRef.current) return;
    // Two overlapping fetches from the same cursor: only the first to land counts, so nothing is logged twice.
    // If this one saw further than the one that won, fetch the rest from where that one stopped.
    if (cursor.current !== from) { if (r.next > cursor.current) await pullEvents(); return; }
    cursor.current = r.next;
    ingest(r.events);
  }, [client, matchId, ingest]);

  const refreshOnce = useCallback(async () => {
    if (!client) return;
    try {
      let s = await client.state(matchId);
      if (s.phase === 'reveal' && s.seat !== null && !revealed.current) {
        revealed.current = true;
        await client.reveal(matchId).catch((e) => {
          if (!String(e).includes('already revealed')) setError(`Could not reveal your seed: ${(e as Error).message}`);
        });
        s = await client.state(matchId);
      }
      if (matchId !== matchRef.current) return;
      // Never step back: a slow response must not overwrite a newer snapshot.
      setSnap((old) => (old && old.matchId === s.matchId && old.seq > s.seq ? old : s));
      setOffline(false);
      await pullEvents();
    } catch (e) {
      const msg = String((e as Error).message);
      if (isNetworkError(e)) setOffline(true); // not the player's problem: show "reconnecting", keep polling
      else if (msg.includes('404')) setNotFound(true);
      else if (!msg.includes('429')) setError(msg.replace(/^.*?→ \d+: /, ''));
    }
  }, [client, matchId, pullEvents]);
  const refreshOnceRef = useRef(refreshOnce);
  refreshOnceRef.current = refreshOnce;

  // Single-flight: notices that arrive while a refresh runs just schedule one more pass, so pushes a few ms
  // apart never run side by side. The loop always uses the latest match's fetch.
  const refreshing = useRef(false);
  const dirty = useRef(false);
  const refresh = useCallback(async () => {
    if (sendingRef.current) return;
    if (refreshing.current) { dirty.current = true; return; }
    refreshing.current = true;
    try {
      do {
        dirty.current = false;
        await refreshOnceRef.current();
      } while (dirty.current && !sendingRef.current);
    } finally { refreshing.current = false; }
  }, []);

  useEffect(() => {
    cursor.current = 0;
    revealed.current = false;
    setEvents([]); setSnap(null); setNotFound(false);
  }, [matchId]);

  const live = useLiveTopic(`match:${matchId.toLowerCase()}`, () => { refresh(); });
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, live ? SAFETY_POLL_MS : POLL_MS);
    return () => clearInterval(t);
  }, [refresh, live, matchId]);

  const send = useCallback(async (a: Action) => {
    if (!client || !snap || sendingRef.current) return false;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      let next = await client.move(matchId, snap, a).catch(async (e) => {
        // A concede is legal at any point, even in the opponent's turn, so if the board moved on since this view
        // (the bot played meanwhile), sign it again against the latest position instead of failing with "stale seq".
        if (a.type !== 'concede' || !String((e as Error).message).includes('stale seq')) throw e;
        return null;
      });
      for (let tries = 0; !next && tries < 3; tries++) {
        next = await client.move(matchId, await client.state(matchId), a).catch((e) => {
          if (!String((e as Error).message).includes('stale seq')) throw e;
          return null;
        });
      }
      if (!next) throw new Error('The board kept changing: try conceding again.');
      setSnap(next);
    } catch (e) {
      if (isNetworkError(e)) { setOffline(true); setError('Lost the connection to the referee: that move may not have gone through. The board updates once it’s back.'); }
      else setError(String((e as Error).message).replace(/^.*?→ \d+: /, ''));
      // Stale view (e.g. a timeout ended the turn): resync.
      sendingRef.current = false;
      await refresh();
      return false;
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
    // The move is in, so the next one may go now: the event log catches up behind it (pullEvents is overlap-safe).
    // Awaiting it inside the lock dropped any click made meanwhile, such as a concede, without a word.
    pullEvents().catch(() => { /* the next refresh fetches them */ });
    return true;
  }, [client, snap, matchId, pullEvents, refresh]);

  return { snap, events, error, notFound, offline, sending, hits, send, clearError: () => setError(null) };
}
