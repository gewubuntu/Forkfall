import { COSMETIC_SETS } from '@forkfall/engine';
import { ForkfallClient } from '@forkfall/sdk';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chain } from '../src/chain.ts';
import { createApi } from '../src/http.ts';
import { Lobby } from '../src/lobby.ts';
import { Profiles } from '../src/profiles.ts';

// Scripted balances: one player owns every Agents Common, nobody owns anything else.
const collectors = new Set<string>();
const agentCommons = COSMETIC_SETS.find((s) => s.key === 'agents')!.cards.filter((c) => c.rarity === 'common');
const file = join(mkdtempSync(join(tmpdir(), 'ff-profiles-')), 'profiles.json');
const profiles = new Profiles(file, async (a) => new Map(collectors.has(a.toLowerCase()) ? agentCommons.map((c) => [c.id, 1]) : []));
const lobby = new Lobby({ chain: new Chain(null), house: privateKeyToAccount(generatePrivateKey()), profiles });
const { server } = createApi(lobby, { ratePerSec: 10_000, profiles });
let url = '';

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const newClient = async () => { const c = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey())); await c.connect(); return c; };

describe('profiles and cosmetics', () => {
  it('unlocks the Graduate title with the tutorial and set cosmetics from balances', async () => {
    const c = await newClient();
    collectors.add(c.address.toLowerCase());
    const before = await c.profile(c.address);
    expect(before.profile).toEqual({ title: null, cardBack: null, badge: null, tutorial: false, lessons: [] });
    expect(before.unlocked).toEqual(['back:agents']);

    await c.completeTutorial();
    const after = await c.profile(c.address);
    expect(after.profile.tutorial).toBe(true);
    expect(after.unlocked.sort()).toEqual(['back:agents', 'title:graduate']);

    await c.equip({ title: 'title:graduate', cardBack: 'back:agents' });
    expect((await c.profile(c.address)).profile).toMatchObject({ title: 'title:graduate', cardBack: 'back:agents', badge: null });
    // Persisted to disk, keyed by lowercase address.
    expect(JSON.parse(readFileSync(file, 'utf8'))[c.address.toLowerCase()].cardBack).toBe('back:agents');

    await c.equip({ cardBack: null });
    expect((await c.profile(c.address)).profile).toMatchObject({ title: 'title:graduate', cardBack: null });
  });

  it('unlocks Scholar once every lesson is done, and refuses unknown lessons', async () => {
    const c = await newClient();
    for (const l of ['prophets', 'brokers', 'degens']) await c.completeTutorial(l);
    let p = await c.profile(c.address);
    expect(p.profile).toMatchObject({ tutorial: false, lessons: ['prophets', 'brokers', 'degens'] });
    expect(p.unlocked).not.toContain('title:scholar');
    await c.completeTutorial('basics');
    await c.completeTutorial('basics'); // idempotent
    p = await c.profile(c.address);
    expect(p.profile.lessons).toEqual(['prophets', 'brokers', 'degens', 'basics']);
    expect(p.unlocked).toEqual(expect.arrayContaining(['title:graduate', 'title:scholar']));
    await c.equip({ title: 'title:scholar' });
    await expect(c.completeTutorial('poker')).rejects.toThrow(/unknown lesson/);
  });

  it('reads profiles saved before lessons existed', () => {
    const old = join(mkdtempSync(join(tmpdir(), 'ff-profiles-old-')), 'p.json');
    writeFileSync(old, JSON.stringify({ '0xabc': { title: 'title:graduate', cardBack: null, badge: null, tutorial: true } }));
    expect(new Profiles(old).get('0xABC')).toMatchObject({ tutorial: true, lessons: ['basics'], title: 'title:graduate' });
  });

  it('refuses locked, unknown and wrong-kind cosmetics, and needs a session', async () => {
    const c = await newClient();
    await expect(c.equip({ title: 'title:graduate' })).rejects.toThrow(/locked: Finish the tutorial/);
    await expect(c.equip({ badge: 'badge:poncho' })).rejects.toThrow(/locked/);
    await expect(c.equip({ title: 'back:agents' })).rejects.toThrow(/unknown title/);
    await expect(c.equip({ cardBack: 'back:nope' })).rejects.toThrow(/unknown cardBack/);
    const anon = await fetch(`${url}/v1/profile/cosmetics`, { method: 'POST', body: JSON.stringify({ title: null }) });
    expect(anon.status).toBe(401);
  });

  it('shows equipped cosmetics to everyone in a match', async () => {
    const c = await newClient();
    await c.completeTutorial();
    await c.equip({ title: 'title:graduate' });
    const matchId = await c.practice({ race: 'agents', botRace: 'degens' });
    const s = await c.state(matchId);
    const me = s.players.find((p) => p.address.toLowerCase() === c.address.toLowerCase())!;
    expect(me.cosmetics).toEqual({ title: 'title:graduate', cardBack: null, badge: null });
    expect(s.players.find((p) => p !== me)!.cosmetics).toEqual({ title: null, cardBack: null, badge: null });
  });
});
