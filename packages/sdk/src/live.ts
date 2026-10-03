/**
 * Live notices from the referee (`/v1/live`): one WebSocket per client instead of polling. Notices are signals
 * only ("match moved", "your challenge was accepted"); fetch the details through the REST API as usual.
 * Reconnects with backoff, re-authenticates and re-subscribes on its own, and tells you when it did
 * (`onReconnect`) so you can refetch anything you might have missed while it was down. Works in browsers and
 * Node 22+ (global WebSocket).
 */
export interface LiveEvent {
  topic: string;
  kind: string;
  [k: string]: unknown;
}

type Listener = (e: LiveEvent) => void;

export interface LiveClientOptions {
  /** Current session token (read on every (re)connect, so a refreshed session is picked up). */
  token?: () => string | undefined;
  /** Called after a reconnect (not the first connect): refetch whatever you show. */
  onReconnect?: () => void;
  /** Called whenever the connection opens or closes. */
  onStatus?: (connected: boolean) => void;
  maxBackoffMs?: number;
}

export class LiveClient {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private attempts = 0;
  private everConnected = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private statusFns = new Set<(connected: boolean) => void>();
  private reconnectFns = new Set<() => void>();
  connected = false;

  constructor(readonly url: string, private opts: LiveClientOptions = {}) {
    this.connect();
  }

  /** `ws(s)://host/v1/live` for an API base URL ('' = this page's origin). */
  static urlFor(baseUrl: string): string {
    const base = baseUrl || (typeof location !== 'undefined' ? location.origin : 'http://localhost:8787');
    return base.replace(/^http/, 'ws').replace(/\/$/, '') + '/v1/live';
  }

  /** Listen to a topic ('me', 'lobby', 'match:<id>'). Returns an unsubscribe function. */
  on(topic: string, fn: Listener): () => void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
      this.send({ type: 'sub', topic });
    }
    set.add(fn);
    return () => {
      const s = this.listeners.get(topic);
      if (!s) return;
      s.delete(fn);
      if (!s.size) { this.listeners.delete(topic); this.send({ type: 'unsub', topic }); }
    };
  }

  /** Several parts of an app can share one socket: each gets its own status and reconnect callbacks. */
  onStatusChange(fn: (connected: boolean) => void): () => void { this.statusFns.add(fn); return () => this.statusFns.delete(fn); }
  onReconnected(fn: () => void): () => void { this.reconnectFns.add(fn); return () => this.reconnectFns.delete(fn); }

  /** Re-authenticate (after sign-in or a session refresh) without reconnecting. */
  reauth() {
    const t = this.opts.token?.();
    if (t) this.send({ type: 'auth', token: t });
    if (this.listeners.has('me')) this.send({ type: 'sub', topic: 'me' });
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  private connect() {
    if (this.closed || typeof WebSocket === 'undefined') return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.attempts = 0;
      this.connected = true;
      this.opts.onStatus?.(true);
      for (const fn of this.statusFns) fn(true);
      const t = this.opts.token?.();
      if (t) ws.send(JSON.stringify({ type: 'auth', token: t }));
      for (const topic of this.listeners.keys()) ws.send(JSON.stringify({ type: 'sub', topic }));
      if (this.everConnected) { this.opts.onReconnect?.(); for (const fn of this.reconnectFns) fn(); }
      this.everConnected = true;
    });
    ws.addEventListener('message', (e) => {
      let m: { type?: string } & Partial<LiveEvent>;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.type !== 'event' || !m.topic) return;
      for (const fn of this.listeners.get(m.topic) ?? []) fn(m as LiveEvent);
    });
    const down = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.connected) {
        this.connected = false;
        this.opts.onStatus?.(false);
        for (const fn of this.statusFns) fn(false);
      }
      if (this.closed) return;
      const delay = Math.min(this.opts.maxBackoffMs ?? 15_000, 500 * 2 ** this.attempts++) * (0.75 + Math.random() / 2);
      this.timer = setTimeout(() => this.connect(), delay);
      (this.timer as { unref?: () => void }).unref?.(); // never keep a Node process alive just to reconnect
    };
    ws.addEventListener('close', down);
    ws.addEventListener('error', () => ws.close());
  }

  private send(m: object) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
  }
}
