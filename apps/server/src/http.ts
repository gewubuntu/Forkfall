import { CARDS, type Action } from '@forkfall/engine';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from 'viem';
import { ApiError, type Lobby } from './lobby.ts';

interface Session { address: Address; agent: boolean; bucket: number; refilledAt: number }

/** Same rate limit for every player, human or agent. */
const RATE_PER_SEC = 10;
const BURST = 30;

export function createApi(lobby: Lobby, opts: { staticDir?: string; ratePerSec?: number } = {}) {
  const ratePerSec = opts.ratePerSec ?? RATE_PER_SEC;
  const burst = Math.max(BURST, ratePerSec * 3);
  const sessions = new Map<string, Session>();
  const nonces = new Map<string, string>();

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (!url.pathname.startsWith('/v1/')) return serveStatic(url.pathname, res, opts.staticDir);
      const session = authSession(req);
      if (session) rateLimit(session, Date.now());
      const body = req.method === 'POST' ? await readJson(req) : {};
      const out = await route(req.method ?? 'GET', url, body, session);
      send(res, 200, out);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500;
      if (status === 500) console.error(e);
      send(res, status, { error: (e as Error).message });
    }
  };

  function authSession(req: IncomingMessage): Session | null {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return null;
    return sessions.get(h.slice(7)) ?? null;
  }

  function need(s: Session | null): Session {
    if (!s) throw new ApiError(401, 'authenticate first (GET /v1/auth/nonce, POST /v1/auth)');
    return s;
  }

  function rateLimit(s: Session, now: number) {
    s.bucket = Math.min(burst, s.bucket + ((now - s.refilledAt) / 1000) * ratePerSec);
    s.refilledAt = now;
    if (s.bucket < 1) throw new ApiError(429, 'rate limited');
    s.bucket -= 1;
  }

  async function route(method: string, url: URL, body: any, session: Session | null): Promise<unknown> {
    const p = url.pathname.split('/').filter(Boolean).slice(1); // drop "v1"
    const key = `${method} /${p.map((x, i) => (p[0] === 'matches' && i === 1 ? ':id' : x)).join('/')}`;
    const matchId = p[1] as Hex;
    switch (key) {
      case 'GET /config':
        return {
          chainId: lobby.opts.chain.chainId,
          settlement: lobby.opts.chain.settlement,
          onchain: lobby.opts.chain.online,
          domain: { ...lobby.domain, chainId: Number(lobby.domain.chainId) },
          season: await lobby.opts.chain.season(),
          turnSeconds: lobby.turnMs / 1000,
          bankSeconds: lobby.bankMs / 1000,
          house: lobby.opts.house.address,
        };
      case 'GET /cards': return CARDS;
      case 'GET /auth/nonce': {
        const a = url.searchParams.get('address') ?? '';
        if (!isAddress(a)) throw new ApiError(400, 'address required');
        const message = `Forkfall login\naddress: ${getAddress(a)}\nnonce: ${randomBytes(12).toString('hex')}`;
        nonces.set(getAddress(a), message);
        return { message };
      }
      case 'POST /auth': {
        if (!isAddress(body.address ?? '')) throw new ApiError(400, 'address required');
        const address = getAddress(body.address);
        const message = nonces.get(address);
        if (!message || message !== body.message) throw new ApiError(400, 'unknown or stale nonce');
        const ok = await verifyMessage({ address, message, signature: body.signature }).catch(() => false);
        if (!ok) throw new ApiError(401, 'bad signature');
        nonces.delete(address);
        const token = randomBytes(24).toString('hex');
        sessions.set(token, { address, agent: !!body.agent, bucket: burst, refilledAt: Date.now() });
        return { token, address };
      }
      case 'POST /queue': { const s = need(session); return lobby.enqueue(s.address, body, s.agent); }
      case 'GET /queue': return lobby.queueStatus(need(session).address);
      case 'DELETE /queue': lobby.leaveQueue(need(session).address); return { ok: true };
      case 'POST /practice': { const s = need(session); return lobby.practice(s.address, body, s.agent); }
      case 'GET /matches': return { matches: lobby.list() };
      case 'GET /leaderboard': return lobby.leaderboard();
      case 'GET /matches/:id': return lobby.snapshot(lobby.get(matchId), session?.address ?? null);
      case 'GET /matches/:id/events':
        return lobby.eventsSince(lobby.get(matchId), session?.address ?? null, Number(url.searchParams.get('since') ?? 0));
      case 'POST /matches/:id/reveal': return lobby.reveal(need(session).address, matchId, body.seedShare, body.deckSalt);
      case 'POST /matches/:id/moves':
        return lobby.submitMove(need(session).address, matchId, Number(body.seq), body.action as Action, body.signature);
      case 'GET /matches/:id/result': return lobby.resultFor(matchId);
      case 'POST /matches/:id/result': return lobby.submitResultSig(need(session).address, matchId, body.signature);
      case 'GET /matches/:id/settlement': return lobby.settlement(matchId);
      case 'GET /matches/:id/log': return lobby.log(matchId);
      default: throw new ApiError(404, `no route ${key}`);
    }
  }

  return { handler, server: createServer(handler) };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new ApiError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'invalid JSON'); }
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function serveStatic(path: string, res: ServerResponse, dir?: string) {
  if (!dir) throw new ApiError(404, 'not found');
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  let file = join(dir, rel);
  if (!file.startsWith(dir) || !existsSync(file)) file = join(dir, 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}
