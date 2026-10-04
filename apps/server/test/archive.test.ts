import { ForkfallClient, replayLog, runMatch } from '@forkfall/sdk';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, describe, expect, it } from 'vitest';
import { Chain } from '../src/chain.ts';
import { createApi } from '../src/http.ts';
import { Lobby, type ArchivedMatch } from '../src/lobby.ts';

const dirs: string[] = [];
const servers: { close(): void }[] = [];
afterAll(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A referee that archives finished matches to `dir` (as main.ts does) and reads them back on demand. */
async function referee(dir: string, clock: { t: number }) {
  const file = (id: Hex) => join(dir, `${id}.json`);
  const loads: Hex[] = [];
  const lobby = new Lobby({
    chain: new Chain(null), house: privateKeyToAccount(generatePrivateKey()), now: () => clock.t, unloadAfterSeconds: 60,
    archive: { load(id) { loads.push(id); try { return JSON.parse(readFileSync(file(id), 'utf8')) as ArchivedMatch; } catch { return null; } } },
  });
  lobby.onChange = (m) => {
    if (m.phase === 'ended') writeFileSync(file(m.id), JSON.stringify(lobby.archive(m.id)));
    return true;
  };
  const { server } = createApi(lobby, { ratePerSec: 10_000 });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { lobby, loads, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function finishedMatch(url: string) {
  const a = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
  const b = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
  await a.connect(); await b.connect();
  const id = await b.acceptChallenge((await a.createChallenge({ race: 'brokers' })).code, { race: 'degens' });
  await Promise.all([runMatch(a, id, { pollMs: 2, live: false }), runMatch(b, id, { pollMs: 2, live: false })]);
  return { a, b, id };
}

const dropNow = <T extends { now?: number }>(s: T) => ({ ...s, now: undefined });

describe('finished matches are unloaded from memory and reloaded from the archive', () => {
  it('unloads an idle finished match and serves the same state, events, log and summary after reloading', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-archive-')); dirs.push(dir);
    const clock = { t: Date.now() };
    const { lobby, loads, url } = await referee(dir, clock);
    const { a, id } = await finishedMatch(url);

    const snap = await a.state(id);
    const events = await a.events(id);
    const log = await a.log(id);
    const summary = (await a.matches()).matches.find((x) => x.matchId === id)!;
    expect(summary.phase).toBe('ended');
    expect(summary.turn).toBeGreaterThan(0);

    lobby.tick();
    expect(lobby.get(id).cold).toBeUndefined(); // used just now: stays loaded
    clock.t += 61_000;
    lobby.tick();
    const m = lobby.get(id);
    expect(m.cold).toEqual({ endReason: snap.view!.endReason, seq: log.moves.length });
    expect([m.state, m.events.length, m.moves.length]).toEqual([undefined, 0, 0]);

    // Lists and settlement status work without loading it.
    expect((await a.matches()).matches.find((x) => x.matchId === id)).toEqual(summary);
    expect(await a.settlement(id)).toMatchObject({ byReferee: false });
    expect(loads).toEqual([]);

    // Opening it replays it from the archive, once. Each way in reloads it on its own.
    expect(await a.events(id)).toEqual(events);
    expect(loads).toEqual([id]);
    expect(dropNow(await a.state(id))).toEqual(dropNow(snap));
    expect(await a.log(id)).toEqual(log);
    expect(loads).toEqual([id]);
    expect(lobby.get(id).cold).toBeUndefined();
    for (const open of [() => a.state(id), () => a.log(id)]) {
      clock.t += 61_000;
      lobby.tick();
      expect(lobby.get(id).cold).toBeDefined();
      await open();
      expect(lobby.get(id).cold).toBeUndefined();
    }
  }, 30_000);

  it('reloads an unloaded match before saving a change to it, so the archive keeps the whole log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-archive-')); dirs.push(dir);
    const clock = { t: Date.now() };
    const { lobby, url } = await referee(dir, clock);
    const { a, id } = await finishedMatch(url);
    const log = await a.log(id);
    clock.t += 61_000;
    lobby.tick();
    expect(lobby.get(id).cold).toBeDefined();

    await a.signResult(id); // a change to a finished match: rewrites its archive file
    const onDisk = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as ArchivedMatch;
    expect(onDisk.log).toEqual(log);
    expect(replayLog(onDisk.log).ok).toBe(true);
  }, 30_000);

  it('restores archived matches at startup without replaying them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-archive-')); dirs.push(dir);
    const clock = { t: Date.now() };
    const first = await referee(dir, clock);
    const { a, id } = await finishedMatch(first.url);
    const log = await a.log(id);
    const summary = (await a.matches()).matches.find((x) => x.matchId === id)!;

    const second = await referee(dir, clock);
    expect(second.lobby.restore(JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')))).toBe(true);
    expect(second.lobby.get(id).cold).toBeDefined();
    expect(second.lobby.list().find((x) => x.matchId === id)).toEqual(summary);
    expect(second.loads).toEqual([]);
    expect(second.lobby.log(id)).toEqual(log);
    expect(second.loads).toEqual([id]);
  }, 30_000);

  it('a missing archive file fails only that match, with a 500', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-archive-')); dirs.push(dir);
    const clock = { t: Date.now() };
    const { lobby, url } = await referee(dir, clock);
    const { a, id } = await finishedMatch(url);
    clock.t += 61_000;
    lobby.tick();
    rmSync(join(dir, `${id}.json`));
    await expect(a.state(id)).rejects.toThrow(/500|could not be loaded/);
    expect((await a.matches()).matches.some((x) => x.matchId === id)).toBe(true);
  }, 30_000);
});
