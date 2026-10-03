import { LiveClient, type LiveEvent } from '@forkfall/sdk';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.tsx';

const SERVER = import.meta.env.VITE_SERVER_URL ?? '';
let anonymous: LiveClient | null = null;
let anonymousIdle: ReturnType<typeof setTimeout> | undefined;

/** The shared signed-out socket (spectating). Closed a few seconds after its last listener leaves. */
function anonymousLive(): LiveClient {
  clearTimeout(anonymousIdle);
  return (anonymous ??= new LiveClient(LiveClient.urlFor(SERVER)));
}
function releaseAnonymous(live: LiveClient) {
  if (live !== anonymous) return;
  clearTimeout(anonymousIdle);
  anonymousIdle = setTimeout(() => {
    if (anonymous && !anonymous.hasListeners) { anonymous.close(); anonymous = null; }
  }, 5000);
}

/**
 * Listen to a live topic from the referee: 'me' (your notices: new match, challenges, quests), 'lobby' (live
 * matches), or 'match:<id>'. Signed in, it shares the session's socket; signed out (spectating), an anonymous one.
 * The handler also runs after a reconnect (kind 'reconnect'), so a refetch there covers anything missed.
 * Returns whether pushes for this topic are flowing (socket up, and for 'me' the session accepted): callers
 * poll slowly while it is true, and at their old pace while it isn't.
 */
export function useLiveTopic(topic: string | null, handler: (e: LiveEvent) => void): boolean {
  const { client } = useAuth();
  const fn = useRef(handler);
  fn.current = handler;
  const live = !topic ? null : client ? client.live() : topic !== 'me' ? anonymousLive() : null;
  const [up, setUp] = useState(() => (live && topic ? live.isUp(topic) : false));

  useEffect(() => {
    if (!live || !topic) { setUp(false); return; }
    setUp(live.isUp(topic));
    const offStatus = live.onStatusChange(() => setUp(live.isUp(topic)));
    const offReconnect = live.onReconnected(() => fn.current({ topic, kind: 'reconnect' }));
    const off = live.on(topic, (e) => fn.current(e));
    return () => { off(); offStatus(); offReconnect(); releaseAnonymous(live); };
  }, [live, topic]);

  return up;
}
