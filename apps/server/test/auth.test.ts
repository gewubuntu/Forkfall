import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import {
  actionHash, buildSessionMessage, ForkfallClient, MOVE_TYPES, runMatch, sessionProofMessage, type Delegation,
} from '@forkfall/sdk';
import { Chain } from '../src/chain.ts';
import { createApi } from '../src/http.ts';
import { Lobby } from '../src/lobby.ts';

const lobby = new Lobby({ chain: new Chain(null), house: privateKeyToAccount(generatePrivateKey()) });
const { server } = createApi(lobby, { ratePerSec: 10_000 });
let url = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const DOMAIN = 'play.forkfall.test';

async function walletLogin(opts: { expiresInSec?: number; chainId?: number; domain?: string } = {}) {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const sessionKey = privateKeyToAccount(generatePrivateKey());
  const client = new ForkfallClient(url, sessionKey, {
    wallet: wallet.address,
    signResult: (td) => wallet.signTypedData(td),
  });
  const nonce = await client.nonce();
  const message = buildSessionMessage({
    domain: opts.domain ?? DOMAIN, uri: `https://${DOMAIN}`, wallet: wallet.address, sessionKey: sessionKey.address,
    chainId: opts.chainId ?? 31337, nonce, expiresAt: new Date(Date.now() + (opts.expiresInSec ?? 3600) * 1000),
  });
  const delegation: Delegation = { message, signature: await wallet.signMessage({ message }) };
  return { wallet, sessionKey, client, delegation };
}

async function postSession(body: unknown, origin?: string) {
  return fetch(`${url}/v1/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}

describe('wallet sign-in with session keys', () => {
  it('one wallet signature authorizes a session key that plays a full match', async () => {
    const { wallet, sessionKey, client, delegation } = await walletLogin();
    await client.connectSession(delegation);
    const me = await client.me();
    expect(me.address).toBe(wallet.address);
    expect(me.sessionKey).toBe(sessionKey.address);
    expect(me.expiresAt).toBeGreaterThan(Date.now());

    const matchId = await client.practice({ race: 'agents', botRace: 'degens' });
    const loop = runMatch(client, matchId, { pollMs: 5 });
    for (let i = 0; i < 3000 && lobby.get(matchId).phase !== 'ended'; i++) {
      await lobby.stepBots();
      await new Promise((r) => setTimeout(r, 2));
    }
    const end = await loop;
    expect(end.phase).toBe('ended');
    expect(end.players[end.seat!].address).toBe(wallet.address);

    // The wallet (not the session key) signed the result, and the delegation is in the public log.
    await lobby.stepBots();
    const settlement = await client.settlement(matchId) as any;
    expect(settlement.result.playerA).toBe(wallet.address);
    const log = await client.log(matchId) as any;
    expect(log.players[0].delegations).toEqual([delegation]);
  });

  it('a delegation can be resumed with a fresh proof (no new wallet popup)', async () => {
    const { sessionKey, wallet, delegation } = await walletLogin();
    const again = new ForkfallClient(url, sessionKey, { wallet: wallet.address });
    await again.connectSession(delegation);
    expect((await again.me()).address).toBe(wallet.address);
  });

  it('rejects a proof from a key that was not delegated', async () => {
    const { client, delegation } = await walletLogin();
    const nonce = await client.nonce();
    const stranger = privateKeyToAccount(generatePrivateKey());
    const res = await postSession({ delegation, nonce, proof: await stranger.signMessage({ message: sessionProofMessage(nonce) }) });
    expect(res.status).toBe(401);
  });

  it('nonces are single use', async () => {
    const { client, sessionKey, delegation } = await walletLogin();
    const nonce = await client.nonce();
    const proof = await sessionKey.signMessage({ message: sessionProofMessage(nonce) });
    expect((await postSession({ delegation, nonce, proof })).status).toBe(200);
    expect((await postSession({ delegation, nonce, proof })).status).toBe(400);
  });

  it('rejects expired, wrong-chain, tampered and phishing-domain delegations', async () => {
    const tryLogin = async (d: { delegation: Delegation; sessionKey: { signMessage: (a: { message: string }) => Promise<Hex> }; client: ForkfallClient }, origin?: string) => {
      const nonce = await d.client.nonce();
      return postSession({ delegation: d.delegation, nonce, proof: await d.sessionKey.signMessage({ message: sessionProofMessage(nonce) }) }, origin);
    };
    expect((await tryLogin(await walletLogin({ expiresInSec: -10 }))).status).toBe(401);
    expect((await tryLogin(await walletLogin({ chainId: 8453 }))).status).toBe(400);
    const tampered = await walletLogin();
    tampered.delegation = { ...tampered.delegation, message: tampered.delegation.message.replace('Sign in to Forkfall', 'Sign in to Forkfa11') };
    expect((await tryLogin(tampered)).status).toBe(401);
    expect((await tryLogin(await walletLogin(), 'https://evil.example')).status).toBe(401);
    expect((await tryLogin(await walletLogin(), `https://${DOMAIN}`)).status).toBe(200);
    expect((await tryLogin(await walletLogin({ expiresInSec: 25 * 3600 }))).status).toBe(400);
  });

  it('moves signed by a random key are rejected for a session login', async () => {
    const a = await walletLogin();
    const b = await walletLogin();
    await a.client.connectSession(a.delegation);
    await b.client.connectSession(b.delegation);
    await a.client.queue({ mode: 'casual', race: 'agents' });
    const { matchId } = await b.client.queue({ mode: 'casual', race: 'brokers' });
    await a.client.reveal(matchId!); await b.client.reveal(matchId!);
    const snap = await a.client.state(matchId!);
    const mover = snap.view!.active === snap.seat ? a : b;
    const s = await mover.client.state(matchId!);
    const rogue = privateKeyToAccount(generatePrivateKey());
    const signature = await rogue.signTypedData({
      domain: mover.client.config!.domain, types: MOVE_TYPES, primaryType: 'Move',
      message: { matchId: matchId!, seq: s.seq, prevHash: s.head, actionHash: actionHash({ type: 'endTurn' }) },
    });
    const res = await fetch(`${url}/v1/matches/${matchId}/moves`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${mover.client.token}` },
      body: JSON.stringify({ seq: s.seq, action: { type: 'endTurn' }, signature }),
    });
    expect(res.status).toBe(401);
    // and the real session key works
    await mover.client.move(matchId!, s, { type: 'endTurn' });
  });

  it('logout revokes the token', async () => {
    const { client, delegation } = await walletLogin();
    await client.connectSession(delegation);
    const token = client.token;
    await client.logout();
    const res = await fetch(`${url}/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });
});
