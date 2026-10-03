import { LiveClient, type LiveEvent } from '@forkfall/sdk';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.tsx';

const SERVER = import.meta.env.VITE_SERVER_URL ?? '';
let anonymous: LiveClient | null = null;

/**
 * Listen to a live topic from the referee: 'me' (your notices: new match, challenges, quests), 'lobby' (live
 * matches), or 'match:<id>'. Signed in, it shares the session's socket; signed out (spectating), an anonymous one.
 * The handler also runs after a reconnect (kind 'reconnect'), so a refetch there covers anything missed.
 * Returns whether the socket is up: callers poll slowly while it is, and at their old pace while it isn't.
 */
export function useLiveTopic(topic: string | null, handler: (e: LiveEvent) => void): boolean {
  const { client } = useAuth();
  const fn = useRef(handler);
  fn.current = handler;
  const live = client ? client.live() : topic && topic !== 'me' ? (anonymous ??= new LiveClient(LiveClient.urlFor(SERVER))) : null;
  const [connected, setConnected] = useState(live?.connected ?? false);

  useEffect(() => {
    if (!live || !topic) return;
    setConnected(live.connected);
    const offStatus = live.onStatusChange(setConnected);
    const offReconnect = live.onReconnected(() => fn.current({ topic, kind: 'reconnect' }));
    const off = live.on(topic, (e) => fn.current(e));
    return () => { off(); offStatus(); offReconnect(); };
  }, [live, topic]);

  return connected;
}
