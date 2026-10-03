import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * Live notices over one WebSocket per client (`/v1/live`), so clients stop polling. Notices are tiny signals
 * ("match 0x… moved to seq 12", "your challenge was accepted"); clients then fetch through the REST API, which
 * keeps every hidden-information rule in one place: nothing secret ever travels over this socket.
 *
 * Client → server (JSON):
 *   { type: 'auth', token }            sign in with the REST session token (needed for the `me` topic)
 *   { type: 'sub', topic } / 'unsub'   topics: `match:<id>` and `lobby` (anyone), `me` (your own notices)
 *   { type: 'ping' }
 * Server → client:
 *   { type: 'hello' } · { type: 'authed', address } · { type: 'subbed', topic }
 *   { type: 'error', message, auth?: true, topic? }   a failed auth (you're signed out of `me`) or a refused sub
 *   { type: 'unauthed' }                     your session ended (logout or expiry): `me` notices stop
 *   { type: 'event', topic, kind, ...data }   e.g. topic 'match:0x…' kind 'update' {seq, phase};
 *                                             topic 'me' kind 'match' | 'challenge' | 'quests' | 'queue'
 */
export interface LiveBus {
  /** Something about a match changed (a move, a phase, a signature). */
  match(matchId: string, data: Record<string, unknown>): void;
  /** A notice for one player (only their own `me` subscriptions receive it). */
  user(address: string, kind: string, data?: Record<string, unknown>): void;
  /** The public list of live matches changed (coalesced to at most one notice a second). */
  lobby(): void;
}

interface Client {
  ws: WebSocket;
  ip: string;
  token: string | null;
  address: string | null;
  topics: Set<string>;
  alive: boolean;
  /** Token bucket for incoming messages. */
  bucket: number;
  refilledAt: number;
}

export interface LiveOptions {
  /** Resolves a REST session token to its address (null = unknown or expired). */
  authenticate: (token: string) => { address: string } | null;
  path?: string;
  maxTopics?: number;
  maxSocketsPerAddress?: number;
  heartbeatMs?: number;
  /** Open sockets per IP (authenticated or not) and in total. */
  maxSocketsPerIp?: number;
  maxSockets?: number;
  /** Incoming messages per second per socket (burst 3x); a socket that keeps flooding is closed. */
  messagesPerSec?: number;
  /** Take the client IP from X-Forwarded-For (only behind a proxy you control). */
  trustProxy?: boolean;
}

/** A socket whose unsent backlog grows past this isn't reading: drop it rather than buffer for it. */
const MAX_BUFFERED = 256 * 1024;

const MATCH_TOPIC = /^match:0x[0-9a-fA-F]{64}$/;

export class Live implements LiveBus {
  private wss: WebSocketServer;
  private subs = new Map<string, Set<Client>>();
  private clients = new Set<Client>();
  private heartbeat: ReturnType<typeof setInterval>;
  private lobbyTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTopics: number;
  private maxPerAddress: number;
  private perAddress = new Map<string, number>();
  private perIp = new Map<string, number>();

  constructor(server: Server, private opts: LiveOptions) {
    this.maxTopics = opts.maxTopics ?? 32;
    this.maxPerAddress = opts.maxSocketsPerAddress ?? 8;
    this.wss = new WebSocketServer({ server, path: opts.path ?? '/v1/live', maxPayload: 4096 });
    this.wss.on('connection', (ws, req) => this.accept(ws, req));
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) { c.ws.terminate(); continue; }
        c.alive = false;
        c.ws.ping();
        this.stillAuthed(c); // a session that expired drops its `me` topic even if nothing was sent
      }
    }, opts.heartbeatMs ?? 25_000);
    this.heartbeat.unref?.();
  }

  /** Connected sockets (for tests and the startup log). */
  get size() { return this.clients.size; }

  match(matchId: string, data: Record<string, unknown>) {
    this.emit(`match:${matchId.toLowerCase()}`, { kind: 'update', ...data });
  }

  user(address: string, kind: string, data: Record<string, unknown> = {}) {
    this.emit(`me:${address.toLowerCase()}`, { kind, ...data }, 'me');
  }

  lobby() {
    if (this.lobbyTimer) return;
    this.lobbyTimer = setTimeout(() => { this.lobbyTimer = null; this.emit('lobby', { kind: 'matches' }); }, 1000);
    this.lobbyTimer.unref?.();
  }

  /** A session token was revoked (logout): its sockets stop receiving `me` notices right away. */
  revoke(token: string) {
    for (const c of this.clients) if (c.token === token) this.deauth(c, true);
  }

  close() {
    clearInterval(this.heartbeat);
    if (this.lobbyTimer) clearTimeout(this.lobbyTimer);
    for (const c of this.clients) c.ws.terminate();
    this.wss.close();
  }

  private emit(topic: string, data: Record<string, unknown>, shownAs = topic) {
    const set = this.subs.get(topic);
    if (!set?.size) return;
    const msg = JSON.stringify({ type: 'event', topic: shownAs, ...data });
    const personal = topic.startsWith('me:');
    for (const c of [...set]) {
      if (personal && !this.stillAuthed(c)) continue; // logged out or expired since it subscribed
      this.send(c, msg);
    }
  }

  private accept(ws: WebSocket, req: IncomingMessage) {
    const fwd = this.opts.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    const ip = fwd || req.socket.remoteAddress || '?';
    if (this.clients.size >= (this.opts.maxSockets ?? 10_000) || (this.perIp.get(ip) ?? 0) >= (this.opts.maxSocketsPerIp ?? 64)) {
      ws.close(1013, 'too many live connections');
      return;
    }
    const c: Client = { ws, ip, token: null, address: null, topics: new Set(), alive: true, bucket: 0, refilledAt: Date.now() };
    c.bucket = this.rate() * 3;
    this.clients.add(c);
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    ws.on('pong', () => { c.alive = true; });
    ws.on('close', () => this.drop(c));
    ws.on('error', () => this.drop(c));
    ws.on('message', (raw) => {
      try { this.handle(c, raw); } catch (e) {
        // Never let one client's message take the referee down.
        console.error('live message failed', e);
        this.send(c, { type: 'error', message: 'bad message' });
      }
    });
    this.send(c, { type: 'hello' });
  }

  private rate() { return this.opts.messagesPerSec ?? 10; }

  private handle(c: Client, raw: unknown) {
    c.alive = true;
    const now = Date.now();
    c.bucket = Math.min(this.rate() * 3, c.bucket + ((now - c.refilledAt) / 1000) * this.rate());
    c.refilledAt = now;
    if (c.bucket < 1) { c.ws.close(1008, 'too many messages'); return; }
    c.bucket -= 1;
    let m: unknown;
    try { m = JSON.parse(String(raw)); } catch { return this.send(c, { type: 'error', message: 'bad JSON' }); }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return this.send(c, { type: 'error', message: 'expected a JSON object' });
    const { type, token, topic } = m as { type?: unknown; token?: unknown; topic?: unknown };
    switch (type) {
      case 'auth': return this.auth(c, token);
      case 'sub': return this.sub(c, topic);
      case 'unsub': return this.unsub(c, topic);
      case 'ping': return this.send(c, { type: 'pong' });
      default: return this.send(c, { type: 'error', message: 'unknown message type' });
    }
  }

  private auth(c: Client, token: unknown) {
    const s = typeof token === 'string' ? this.opts.authenticate(token) : null;
    if (!s) {
      // A failed (re-)auth signs the socket out: never keep serving an old identity.
      this.deauth(c, false);
      return this.send(c, { type: 'error', auth: true, message: 'unknown or expired session' });
    }
    const address = s.address.toLowerCase();
    if (c.address !== address) {
      if ((this.perAddress.get(address) ?? 0) >= this.maxPerAddress) {
        this.deauth(c, false);
        return this.send(c, { type: 'error', auth: true, message: 'too many live connections for this wallet' });
      }
      this.deauth(c, false); // re-auth as someone else: drop the old personal topic
      c.address = address;
      this.perAddress.set(address, (this.perAddress.get(address) ?? 0) + 1);
    }
    c.token = token as string;
    this.send(c, { type: 'authed', address });
  }

  /** Whether the socket's session is still valid; signs it out (and tells it) when not. */
  private stillAuthed(c: Client): boolean {
    if (!c.address) return false;
    const s = c.token ? this.opts.authenticate(c.token) : null;
    if (s && s.address.toLowerCase() === c.address) return true;
    this.deauth(c, true);
    return false;
  }

  private deauth(c: Client, notify: boolean) {
    if (!c.address) return;
    this.unsub(c, 'me');
    const n = (this.perAddress.get(c.address) ?? 1) - 1;
    if (n > 0) this.perAddress.set(c.address, n); else this.perAddress.delete(c.address);
    c.address = null;
    c.token = null;
    if (notify) this.send(c, { type: 'unauthed' });
  }

  private topicKey(c: Client, topic: unknown): string | null {
    if (topic === 'lobby') return 'lobby';
    if (topic === 'me') return c.address ? `me:${c.address}` : null;
    if (typeof topic === 'string' && MATCH_TOPIC.test(topic)) return topic.toLowerCase();
    return null;
  }

  private sub(c: Client, topic: unknown) {
    const key = this.topicKey(c, topic);
    const t = typeof topic === 'string' ? topic.slice(0, 80) : undefined;
    if (!key) return this.send(c, { type: 'error', topic: t, message: topic === 'me' ? 'authenticate first' : 'unknown topic' });
    if (!c.topics.has(key) && c.topics.size >= this.maxTopics) return this.send(c, { type: 'error', topic: t, message: 'too many subscriptions' });
    c.topics.add(key);
    (this.subs.get(key) ?? this.subs.set(key, new Set()).get(key)!).add(c);
    this.send(c, { type: 'subbed', topic });
  }

  private unsub(c: Client, topic: unknown) {
    const key = this.topicKey(c, topic);
    if (!key) return;
    c.topics.delete(key);
    const set = this.subs.get(key);
    set?.delete(c);
    if (set && !set.size) this.subs.delete(key);
  }

  private drop(c: Client) {
    if (!this.clients.delete(c)) return;
    this.deauth(c, false);
    const n = (this.perIp.get(c.ip) ?? 1) - 1;
    if (n > 0) this.perIp.set(c.ip, n); else this.perIp.delete(c.ip);
    for (const key of c.topics) {
      const set = this.subs.get(key);
      set?.delete(c);
      if (set && !set.size) this.subs.delete(key);
    }
  }

  private send(c: Client, msg: Record<string, unknown> | string) {
    if (c.ws.readyState !== c.ws.OPEN) return;
    if (c.ws.bufferedAmount > MAX_BUFFERED) { c.ws.terminate(); return; } // not reading: don't buffer for it
    c.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
}
