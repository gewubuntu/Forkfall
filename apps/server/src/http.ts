import { CARDS, type Action } from '@forkfall/engine';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from 'viem';
import { ApiError, type Lobby } from './lobby.ts';
import { verifySessionLogin } from './auth.ts';
import { EXPLORER, type AddressBook } from './chain.ts';
import type { HumanVerification } from './humans.ts';
import type { Rewards } from './rewards.ts';
import type { Profiles } from './profiles.ts';
import type { Quests } from './quests.ts';
import { Live } from './live.ts';
import { serveMetadata } from './metadata.ts';
import type { LeaguePayouts } from './league.ts';
import type { Delegation } from '@forkfall/sdk';

interface Session {
  address: Address;
  agent: boolean;
  bucket: number;
  refilledAt: number;
  /** Wallet login: the in-browser key authorized to sign moves, and the SIWE delegation proving it. */
  sessionKey?: Address;
  delegation?: Delegation;
  expiresAt?: number;
}

const NONCE_TTL_MS = 5 * 60 * 1000;

/** Same rate limit for every player, human or agent. */
const RATE_PER_SEC = 10;
const BURST = 30;

export function createApi(lobby: Lobby, opts: { staticDir?: string; ratePerSec?: number; humans?: HumanVerification; rewards?: Rewards; publicUrl?: string; payouts?: LeaguePayouts; profiles?: Profiles; quests?: Quests } = {}) {
  const ratePerSec = opts.ratePerSec ?? RATE_PER_SEC;
  const burst = Math.max(BURST, ratePerSec * 3);
  const sessions = new Map<string, Session>();
  const nonces = new Map<string, string>();
  /** Server-issued nonces for wallet/session login: nonce → expiry. Single use. */
  const issued = new Map<string, number>();

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (serveMetadata(req, res, url.pathname, opts.publicUrl)) return;
      if (!url.pathname.startsWith('/v1/')) return serveStatic(url.pathname, res, opts.staticDir);
      const session = authSession(req);
      if (session) rateLimit(session, Date.now());
      const body = req.method === 'POST' ? await readJson(req) : {};
      const out = await route(req.method ?? 'GET', url, body, session, req);
      send(res, 200, out);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500;
      if (status === 500) console.error(e);
      send(res, status, { error: (e as Error).message });
    }
  };

  function authSession(req: IncomingMessage): Session | null {
    const h = req.headers.authorization;
    return h?.startsWith('Bearer ') ? sessionFor(h.slice(7)) : null;
  }

  function sessionFor(token: string): Session | null {
    const s = sessions.get(token);
    if (s?.expiresAt && s.expiresAt < Date.now()) { sessions.delete(token); return null; }
    return s ?? null;
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

  async function route(method: string, url: URL, body: any, session: Session | null, req: IncomingMessage): Promise<unknown> {
    const p = url.pathname.split('/').filter(Boolean).slice(1); // drop "v1"
    const key = `${method} /${p.map((x, i) => (i === 1 && p[0] === 'matches' ? ':id' : i === 1 && p[0] === 'challenges' ? ':code' : x)).join('/')}`;
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
          contracts: hubContracts(lobby.opts.chain.book),
          explorer: EXPLORER[lobby.opts.chain.chainId] ?? null,
        };
      case 'GET /cards': return CARDS;
      case 'GET /auth/nonce': {
        const a = url.searchParams.get('address') ?? '';
        if (!isAddress(a)) throw new ApiError(400, 'address required');
        const nonce = randomBytes(12).toString('hex');
        const message = `Forkfall login\naddress: ${getAddress(a)}\nnonce: ${nonce}`;
        nonces.set(getAddress(a), message);
        const now = Date.now();
        for (const [n, exp] of issued) if (exp < now) issued.delete(n);
        issued.set(nonce, now + NONCE_TTL_MS);
        return { message, nonce };
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
      case 'POST /auth/session': {
        // Wallet sign-in: SIWE delegation to a session key + the key's proof over a fresh nonce.
        const nonce = String(body.nonce ?? '');
        const exp = issued.get(nonce);
        if (!exp || exp < Date.now()) throw new ApiError(400, 'unknown or expired nonce');
        issued.delete(nonce);
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
        const v = await verifySessionLogin({ delegation: body.delegation, nonce, proof: body.proof, chain: lobby.opts.chain, origin });
        const token = randomBytes(24).toString('hex');
        sessions.set(token, {
          address: v.wallet, agent: false, bucket: burst, refilledAt: Date.now(),
          sessionKey: v.sessionKey, delegation: v.delegation, expiresAt: v.expiresAt,
        });
        return { token, address: v.wallet, sessionKey: v.sessionKey, expiresAt: v.expiresAt };
      }
      case 'GET /auth/me': {
        const s = need(session);
        const chain = lobby.opts.chain;
        const [agent, human, banned, agentId] = await Promise.all([
          chain.isAgent(s.address).catch(() => false),
          chain.isHuman(s.address).catch(() => false),
          chain.isBanned(s.address).catch(() => false),
          chain.agentOf(s.address).catch(() => 0),
        ]);
        return {
          address: s.address, sessionKey: s.sessionKey ?? null, expiresAt: s.expiresAt ?? null,
          agent: s.agent || agent, agentId, verifiedHuman: human, bannedFromRanked: banned, onchain: chain.online,
        };
      }
      case 'POST /auth/logout': {
        const h = req.headers.authorization;
        if (h?.startsWith('Bearer ')) sessions.delete(h.slice(7));
        return { ok: true };
      }
      case 'POST /queue': { const s = need(session); return lobby.enqueue(s.address, body, s.agent); }
      case 'GET /queue': return lobby.queueStatus(need(session).address);
      case 'DELETE /queue': lobby.leaveQueue(need(session).address); return { ok: true };
      case 'POST /practice': { const s = need(session); return lobby.practice(s.address, body, s.agent); }
      case 'GET /human': {
        if (!opts.humans) throw new ApiError(404, 'human verification is not enabled on this server');
        return opts.humans.status(need(session).address);
      }
      case 'POST /human/verify': {
        if (!opts.humans) throw new ApiError(404, 'human verification is not enabled on this server');
        return opts.humans.verify(need(session).address, String(body.method ?? ''), body);
      }
      case 'GET /league': {
        // Agent League: week, entry fee, split, current pot and standings (and your balance with ?address=).
        const league = lobby.opts.league;
        if (!league) return { enabled: false };
        const a = url.searchParams.get('address');
        if (a && !isAddress(a)) throw new ApiError(400, 'address must be an address');
        return league.info(a ? getAddress(a) : null);
      }
      case 'GET /league/claims': {
        const list = (url.searchParams.get('agents') ?? '').split(',').filter(Boolean);
        if (!list.length || !list.every((x) => isAddress(x))) throw new ApiError(400, 'agents=<address,…> required');
        return { claims: opts.payouts?.claims(list.map((x) => getAddress(x))) ?? [] };
      }
      case 'GET /profile': {
        const a = url.searchParams.get('address') as Address | null;
        if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new ApiError(400, 'address required');
        if (!opts.profiles) return { profile: { title: null, cardBack: null, badge: null, tutorial: false, lessons: [] }, unlocked: [] };
        return { profile: opts.profiles.get(a), unlocked: await opts.profiles.unlocked(a) };
      }
      case 'POST /profile/tutorial': {
        if (!opts.profiles) throw new ApiError(503, 'profiles are not enabled on this server');
        const who = need(session).address;
        const lesson = body?.lesson === undefined ? 'basics' : body.lesson;
        if (typeof lesson !== 'string') throw new ApiError(400, 'lesson must be a string');
        try { return { profile: opts.profiles.completeLesson(who, lesson) }; } catch (e) { throw new ApiError(400, (e as Error).message); }
      }
      // ─── Friend challenges (casual) ───
      case 'POST /challenges': {
        const who = need(session);
        return lobby.createChallenge(who.address, body, who.agent);
      }
      case 'GET /challenges': return lobby.challengesFor(need(session).address);
      case 'GET /challenges/:code': return lobby.challengeView(lobby.challenge(p[1]), session?.address ?? null);
      case 'POST /challenges/:code/accept': {
        const who = need(session);
        return lobby.acceptChallenge(who.address, p[1], body, who.agent);
      }
      case 'DELETE /challenges/:code': return lobby.closeChallenge(need(session).address, p[1]);
      case 'GET /quests': {
        if (!opts.quests) throw new ApiError(503, 'quests are not enabled on this server');
        const a = url.searchParams.get('address') ?? session?.address;
        if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new ApiError(400, 'address required');
        const eligible = await opts.quests.eligibleFor(a);
        if (eligible) opts.quests.releaseHeld(a); // verified since: pay what was held without waiting for the re-check
        return { ...opts.quests.status(a), eligible };
      }
      case 'POST /quests/reroll': {
        if (!opts.quests) throw new ApiError(503, 'quests are not enabled on this server');
        const who = need(session).address;
        try { return opts.quests.reroll(who, Number(body?.slot)); } catch (e) { throw new ApiError(400, (e as Error).message); }
      }
      case 'POST /profile/cosmetics': {
        if (!opts.profiles) throw new ApiError(503, 'profiles are not enabled on this server');
        const who = need(session).address;
        try { return { profile: await opts.profiles.equip(who, body) }; } catch (e) { throw new ApiError(400, (e as Error).message); }
      }
      case 'GET /rewards': {
        const a = url.searchParams.get('address') ?? '';
        if (!isAddress(a)) throw new ApiError(400, 'address required');
        return { seasons: opts.rewards?.forPlayer(getAddress(a)) ?? [] };
      }
      case 'GET /matches': {
        const player = url.searchParams.get('player');
        if (player && !isAddress(player)) throw new ApiError(400, 'player must be an address');
        return { matches: lobby.list(player as Address | null) };
      }
      case 'GET /leaderboard': {
        const season = url.searchParams.get('season');
        return lobby.leaderboard(season === null ? undefined : Number(season));
      }
      case 'GET /matches/:id': return lobby.snapshot(lobby.get(matchId), session?.address ?? null);
      case 'GET /matches/:id/events':
        return lobby.eventsSince(lobby.get(matchId), session?.address ?? null, Number(url.searchParams.get('since') ?? 0));
      case 'POST /matches/:id/reveal': return lobby.reveal(need(session).address, matchId, body.seedShare, body.deckSalt);
      case 'POST /matches/:id/moves':
      {
        const s = need(session);
        const auth = s.sessionKey && s.delegation ? { sessionKey: s.sessionKey, delegation: s.delegation } : undefined;
        return lobby.submitMove(s.address, matchId, Number(body.seq), body.action as Action, body.signature, auth);
      }
      case 'GET /matches/:id/result': return lobby.resultFor(matchId);
      case 'POST /matches/:id/result': return lobby.submitResultSig(need(session).address, matchId, body.signature);
      case 'GET /matches/:id/settlement': return lobby.settlement(matchId);
      case 'GET /matches/:id/log': return lobby.log(matchId);
      default: throw new ApiError(404, `no route ${key}`);
    }
  }

  const server = createServer(handler);
  // Live notices (WebSocket on /v1/live): the lobby pushes "something changed" so clients don't poll.
  const live = new Live(server, { authenticate: (token) => sessionFor(token) });
  lobby.bus = live;
  server.on('close', () => live.close());
  return { handler, server, live };
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

const CONTRACT_KEYS = [
  'CardRegistry', 'StarterDecks', 'PackSale', 'Crafting', 'DeckRegistry', 'MatchSettlement',
  'AgentRegistry', 'HumanRegistry', 'SeasonRewards', 'AgentLeague', 'QuestRewards', 'TestUSDC', 'TestFALL',
] as const;

function hubContracts(book: AddressBook | null) {
  if (!book) return null;
  return Object.fromEntries(CONTRACT_KEYS.map((k) => [k, book[k]]));
}
