/**
 * Live notices from the referee (`/v1/live`): one WebSocket per client instead of polling. Notices are signals
 * only ("match moved", "your challenge was accepted"); fetch the details through the REST API as usual.
 * Reconnects with backoff, re-authenticates and re-subscribes on its own, and tells you when it did
 * (`onReconnect`) so you can refetch anything you might have missed while it was down. Works in browsers and
 * Node 22+ (global WebSocket). An open socket keeps a Node process alive: `close()` it when you're done.
 *
 * Check `isUp(topic)` before relying on pushes: it is false while the socket is down, for `me` while the
 * session isn't accepted (signed out, expired, or too many sockets for this wallet), and for a topic the server
 * refused (e.g. over the per-socket subscription limit). Poll as before whenever it is false.
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
  /** Called whenever the connection opens or closes (or sign-in / a subscription changes state). */
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
  /** Topics the server refused (cleared when they're subscribed again). */
  private refused = new Set<string>();
  connected = false;
  /** Whether the server accepted our session (needed for `me`). */
  authed = false;
  /** The last error the server sent (auth or subscription), for diagnostics. */
  lastError: string | null = null;

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
      this.refused.delete(topic);
      this.send({ type: 'sub', topic });
    }
    set.add(fn);
    return () => {
      const s = this.listeners.get(topic);
      if (!s) return;
      s.delete(fn);
      if (!s.size) { this.listeners.delete(topic); this.refused.delete(topic); this.send({ type: 'unsub', topic }); }
    };
  }

  /** Whether pushes for this topic are flowing right now (see the class comment). */
  isUp(topic: string): boolean {
    return this.connected && !this.refused.has(topic) && (topic !== 'me' || this.authed);
  }

  get hasListeners(): boolean { return this.listeners.size > 0; }

  /** Several parts of an app can share one socket: each gets its own status and reconnect callbacks. */
  onStatusChange(fn: (connected: boolean) => void): () => void { this.statusFns.add(fn); return () => this.statusFns.delete(fn); }
  onReconnected(fn: () => void): () => void { this.reconnectFns.add(fn); return () => this.reconnectFns.delete(fn); }

  /** Re-authenticate (after sign-in or a session refresh) without reconnecting. */
  reauth() {
    const t = this.opts.token?.();
    if (t) this.send({ type: 'auth', token: t });
    if (this.listeners.has('me')) { this.refused.delete('me'); this.send({ type: 'sub', topic: 'me' }); }
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    if (this.connected || this.authed) { this.connected = false; this.authed = false; this.status(); }
  }

  private status() {
    this.opts.onStatus?.(this.connected);
    for (const fn of this.statusFns) fn(this.connected);
  }

  private connect() {
    if (this.closed || typeof WebSocket === 'undefined') return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.attempts = 0;
      this.connected = true;
      this.refused.clear();
      const t = this.opts.token?.();
      if (t) ws.send(JSON.stringify({ type: 'auth', token: t }));
      for (const topic of this.listeners.keys()) ws.send(JSON.stringify({ type: 'sub', topic }));
      this.status();
      if (this.everConnected) { this.opts.onReconnect?.(); for (const fn of this.reconnectFns) fn(); }
      this.everConnected = true;
    });
    ws.addEventListener('message', (e) => {
      let m: { type?: string; auth?: boolean; message?: string } & Partial<LiveEvent>;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'authed') { this.authed = true; this.refused.delete('me'); this.status(); return; }
      if (m.type === 'unauthed') { this.authed = false; this.status(); return; }
      if (m.type === 'subbed' && typeof m.topic === 'string') { if (this.refused.delete(m.topic)) this.status(); return; }
      if (m.type === 'error') {
        this.lastError = m.message ?? 'error';
        if (m.auth) { this.authed = false; this.status(); }
        else if (typeof m.topic === 'string' && this.listeners.has(m.topic)) { this.refused.add(m.topic); this.status(); }
        return;
      }
      if (m.type !== 'event' || !m.topic) return;
      for (const fn of this.listeners.get(m.topic) ?? []) fn(m as LiveEvent);
    });
    const down = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.connected) {
        this.connected = false;
        this.authed = false;
        this.status();
      }
      if (this.closed) return;
      const delay = Math.min(this.opts.maxBackoffMs ?? 15_000, 500 * 2 ** this.attempts++) * (0.75 + Math.random() / 2);
      this.timer = setTimeout(() => this.connect(), delay);
      (this.timer as { unref?: () => void }).unref?.(); // never keep a Node process alive just to reconnect
    };
    ws.addEventListener('close', down);
    // An error means down, whatever follows: Node's WebSocket fires no 'close' after a refused connection, so waiting
    // for one stopped the reconnects for good. Handle it once only: closing a socket that never connected fires
    // 'error' again from inside close(), which recursed until the stack overflowed and crashed the agent's process.
    let failed = false;
    ws.addEventListener('error', () => {
      if (failed) return;
      failed = true;
      down();
      try { ws.close(); } catch { /* already closing */ }
    });
  }

  private send(m: object) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
  }
}
