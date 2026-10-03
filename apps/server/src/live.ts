import type { Server } from 'node:http';
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
 *   { type: 'hello' } · { type: 'authed', address } · { type: 'subbed', topic } · { type: 'error', message }
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
  address: string | null;
  topics: Set<string>;
  alive: boolean;
}

export interface LiveOptions {
  /** Resolves a REST session token to its address (null = unknown or expired). */
  authenticate: (token: string) => { address: string } | null;
  path?: string;
  maxTopics?: number;
  maxSocketsPerAddress?: number;
  heartbeatMs?: number;
}

const MATCH_TOPIC = /^match:0x[0-9a-fA-F]{64}$/;

export class Live implements LiveBus {
  private wss: WebSocketServer;
  private subs = new Map<string, Set<Client>>();
  private clients = new Set<Client>();
  private heartbeat: ReturnType<typeof setInterval>;
  private lobbyTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTopics: number;
  private maxPerAddress: number;

  constructor(server: Server, private opts: LiveOptions) {
    this.maxTopics = opts.maxTopics ?? 32;
    this.maxPerAddress = opts.maxSocketsPerAddress ?? 8;
    this.wss = new WebSocketServer({ server, path: opts.path ?? '/v1/live', maxPayload: 4096 });
    this.wss.on('connection', (ws) => this.accept(ws));
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) { c.ws.terminate(); continue; }
        c.alive = false;
        c.ws.ping();
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
    for (const c of set) if (c.ws.readyState === c.ws.OPEN) c.ws.send(msg);
  }

  private accept(ws: WebSocket) {
    const c: Client = { ws, address: null, topics: new Set(), alive: true };
    this.clients.add(c);
    ws.on('pong', () => { c.alive = true; });
    ws.on('close', () => this.drop(c));
    ws.on('error', () => this.drop(c));
    ws.on('message', (raw) => {
      c.alive = true;
      let m: { type?: string; token?: string; topic?: string };
      try { m = JSON.parse(String(raw)); } catch { return this.send(c, { type: 'error', message: 'bad JSON' }); }
      switch (m.type) {
        case 'auth': return this.auth(c, m.token);
        case 'sub': return this.sub(c, m.topic);
        case 'unsub': return this.unsub(c, m.topic);
        case 'ping': return this.send(c, { type: 'pong' });
        default: return this.send(c, { type: 'error', message: 'unknown message type' });
      }
    });
    this.send(c, { type: 'hello' });
  }

  private auth(c: Client, token: unknown) {
    const s = typeof token === 'string' ? this.opts.authenticate(token) : null;
    if (!s) return this.send(c, { type: 'error', message: 'unknown or expired session' });
    const address = s.address.toLowerCase();
    if (c.address !== address) {
      const mine = [...this.clients].filter((x) => x.address === address).length;
      if (mine >= this.maxPerAddress) return this.send(c, { type: 'error', message: 'too many live connections for this wallet' });
      if (c.address) this.unsub(c, 'me'); // re-auth as someone else: drop the old personal topic
      c.address = address;
    }
    this.send(c, { type: 'authed', address });
  }

  private topicKey(c: Client, topic: unknown): string | null {
    if (topic === 'lobby') return 'lobby';
    if (topic === 'me') return c.address ? `me:${c.address}` : null;
    if (typeof topic === 'string' && MATCH_TOPIC.test(topic)) return topic.toLowerCase();
    return null;
  }

  private sub(c: Client, topic: unknown) {
    const key = this.topicKey(c, topic);
    if (!key) return this.send(c, { type: 'error', message: topic === 'me' ? 'authenticate first' : 'unknown topic' });
    if (!c.topics.has(key) && c.topics.size >= this.maxTopics) return this.send(c, { type: 'error', message: 'too many subscriptions' });
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
    for (const key of c.topics) {
      const set = this.subs.get(key);
      set?.delete(c);
      if (set && !set.size) this.subs.delete(key);
    }
  }

  private send(c: Client, msg: Record<string, unknown>) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }
}
