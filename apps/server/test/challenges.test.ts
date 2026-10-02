import { ForkfallClient, runMatch } from '@forkfall/sdk';
import type { AddressInfo } from 'node:net';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chain } from '../src/chain.ts';
import { createApi } from '../src/http.ts';
import { CHALLENGE_TTL_MS, Lobby, MAX_OPEN_CHALLENGES } from '../src/lobby.ts';

let clock = 5_000_000;
const lobby = new Lobby({ chain: new Chain(null), house: privateKeyToAccount(generatePrivateKey()), now: () => clock });
const { server } = createApi(lobby, { ratePerSec: 10_000 });
let url = '';
beforeAll(async () => { await new Promise<void>((r) => server.listen(0, r)); url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => server.close());

const player = async () => { const c = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey())); await c.connect(); return c; };
const fail = (p: Promise<unknown>, status: number, re?: RegExp) =>
  expect(p).rejects.toThrow(new RegExp(`→ ${status}${re ? `.*${re.source}` : ''}`));

describe('friend challenges', () => {
  it('a link anyone can accept starts a casual match both players can play to the end', async () => {
    const a = await player(); const b = await player();
    const c = await a.createChallenge({ race: 'degens' });
    expect(c.code).toMatch(/^[2-9a-z]{10}$/);
    expect(c.state).toBe('open');
    // The link is public, but the challenger's race and the match stay hidden.
    const pub = await (await fetch(`${url}/v1/challenges/${c.code}`)).json();
    expect(pub.from.address).toBe(a.address);
    expect(JSON.stringify(pub)).not.toMatch(/degens|race/);
    const matchId = await b.acceptChallenge(c.code, { race: 'brokers' });
    // The challenger learns the match id by polling (and its stored secrets follow).
    expect((await a.challenge(c.code))).toMatchObject({ state: 'accepted', matchId });
    expect((await (await fetch(`${url}/v1/challenges/${c.code}`)).json()).matchId).toBeUndefined();
    const [ea, eb] = await Promise.all([runMatch(a, matchId, { pollMs: 2 }), runMatch(b, matchId, { pollMs: 2 })]);
    expect(ea.phase).toBe('ended');
    expect(eb.mode).toBe('casual');
    expect(ea.challenge).toBe(c.code);
    expect(ea.players.map((p) => p.race)).toEqual(['degens', 'brokers']);
    await fail(b.acceptChallenge(c.code, { race: 'agents' }), 409, /already accepted/);
  });

  it('only the addressee can accept a directed challenge; nobody accepts their own', async () => {
    const a = await player(); const b = await player(); const stranger = await player();
    const c = await a.createChallenge({ race: 'agents', to: b.address });
    expect(c.to).toBe(b.address.toLowerCase());
    await fail(stranger.acceptChallenge(c.code, { race: 'agents' }), 403, /someone else/);
    await fail(a.acceptChallenge(c.code, { race: 'agents' }), 400, /your own/);
    expect((await b.challenges()).incoming.map((x) => x.code)).toContain(c.code);
    expect((await stranger.challenges()).incoming).toEqual([]);
    await fail(a.createChallenge({ race: 'agents', to: a.address }), 400, /yourself/);
  });

  it('the challenger cancels, the addressee declines, nobody else can close it', async () => {
    const a = await player(); const b = await player(); const stranger = await player();
    const open = await a.createChallenge({ race: 'agents' });
    await fail(stranger.cancelChallenge(open.code), 403);
    expect((await a.cancelChallenge(open.code)).state).toBe('cancelled');
    await fail(b.acceptChallenge(open.code, { race: 'agents' }), 409, /cancelled/);
    const directed = await a.createChallenge({ race: 'agents', to: b.address });
    expect((await b.cancelChallenge(directed.code)).state).toBe('declined');
    expect((await b.challenges()).incoming).toEqual([]);
  });

  it('expires after a day and limits open challenges per player', async () => {
    const a = await player(); const b = await player();
    const c = await a.createChallenge({ race: 'agents' });
    clock += CHALLENGE_TTL_MS + 1;
    expect((await b.challenge(c.code)).state).toBe('expired');
    await fail(b.acceptChallenge(c.code, { race: 'agents' }), 410);
    const many = await player();
    for (let i = 0; i < MAX_OPEN_CHALLENGES; i++) await many.createChallenge({ race: 'agents' });
    await fail(many.createChallenge({ race: 'agents' }), 429, /at most/);
    await fail(b.challenge('nope'), 404);
  });

  it('rematch: a challenge addressed to your last opponent, shown to them as incoming', async () => {
    const a = await player(); const b = await player();
    const first = await a.createChallenge({ race: 'prophets' });
    const matchId = await b.acceptChallenge(first.code, { race: 'degens' });
    await Promise.all([runMatch(a, matchId, { pollMs: 2 }), runMatch(b, matchId, { pollMs: 2 })]);
    const re = await b.createChallenge({ race: 'degens', rematchOf: matchId });
    expect(re).toMatchObject({ to: a.address.toLowerCase(), rematchOf: matchId });
    const incoming = (await a.challenges()).incoming;
    expect(incoming.find((x) => x.rematchOf === matchId)?.from.address).toBe(b.address);
    const second = await a.acceptChallenge(re.code, { race: 'prophets' });
    expect((await b.challenge(re.code)).matchId).toBe(second);
    // Not for matches you didn't play, nor against the house bot.
    const stranger = await player();
    await fail(stranger.createChallenge({ race: 'agents', rematchOf: matchId }), 403);
    const practice = await a.practice({ race: 'agents' });
    const loop = runMatch(a, practice, { pollMs: 2 });
    for (let i = 0; i < 4000 && lobby.get(practice).phase !== 'ended'; i++) {
      await lobby.stepBots(); await new Promise((r) => setTimeout(r, 1));
    }
    await loop;
    await fail(a.createChallenge({ race: 'agents', rematchOf: practice }), 400, /house bot/);
  });
});
