import { ForkfallClient, replayLog, runMatch } from '@forkfall/sdk';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MatchArchive } from '../src/archive.ts';
import { Chain } from '../src/chain.ts';
import { createApi } from '../src/http.ts';
import { Lobby, type ArchivedMatch, type LobbyOptions } from '../src/lobby.ts';

const dirs: string[] = [];
const servers: { close(): void }[] = [];
afterAll(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A referee that archives finished matches to `dir` through MatchArchive (as main.ts does), counting reloads. */
async function referee(dir: string, clock: { t: number }, opts: Partial<LobbyOptions> = {}) {
  const archive = new MatchArchive(dir);
  const loads: Hex[] = [];
  const lobby = new Lobby({
    chain: new Chain(null), house: privateKeyToAccount(generatePrivateKey()), now: () => clock.t, unloadAfterSeconds: 60, ...opts,
    archive: { load(id) { loads.push(id); return archive.load(id); } },
  });
  lobby.onChange = (m) => {
    if (m.phase === 'ended') archive.save(lobby.archive(m.id));
    return true;
  };
  const { server } = createApi(lobby, { ratePerSec: 10_000 });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { lobby, archive, loads, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const indexLines = (dir: string) => readFileSync(join(dir, 'index.jsonl'), 'utf8').split('\n').filter(Boolean);
/** Rewrite an archive file (new mtime) without touching the index, as a crash between the two writes would leave it. */
const rewriteArchive = (dir: string, id: Hex, edit: (rec: ArchivedMatch) => void = () => {}) => {
  const rec = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as ArchivedMatch;
  edit(rec);
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(rec) + ' ');
};

async function finishedMatch(url: string) {
  const a = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
  const b = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
  await a.connect(); await b.connect();
  const id = await b.acceptChallenge((await a.createChallenge({ race: 'brokers' })).code, { race: 'degens' });
  await Promise.all([runMatch(a, id, { pollMs: 2, live: false }), runMatch(b, id, { pollMs: 2, live: false })]);
  return { a, b, id };
}

/** a concedes to b; only b (the winner) signs, so the referee may settle it right away. */
async function concededMatch(url: string) {
  const a = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
  const b = new ForkfallClient(url, privateKeyToAccount(generatePrivateKey()));
  await a.connect(); await b.connect();
  await a.queue({ mode: 'casual', race: 'agents' });
  const { matchId } = await b.queue({ mode: 'casual', race: 'degens' });
  await a.reveal(matchId!); await b.reveal(matchId!);
  await a.move(matchId!, await a.state(matchId!), { type: 'concede' });
  await b.signResult(matchId!);
  return { a, b, id: matchId! };
}

/** A settler that records what it was asked to submit. */
function fakeSettler() {
  const submitted: Hex[] = [];
  return {
    submitted,
    settler: {
      isSettled: async () => false,
      settleByReferee: async (r: { matchId: Hex }) => { submitted.push(r.matchId); return ('0x' + 'ab'.repeat(32)) as Hex; },
      settle: async (r: { matchId: Hex }) => { submitted.push(r.matchId); return ('0x' + 'cd'.repeat(32)) as Hex; },
    },
  };
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

  it('restarts from the archive index, without reading or replaying archive files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-archive-')); dirs.push(dir);
    const clock = { t: Date.now() };
    const first = await referee(dir, clock);
    const { a, id } = await finishedMatch(first.url);
    const log = await a.log(id);
    const summary = (await a.matches()).matches.find((x) => x.matchId === id)!;

    const second = await referee(dir, clock);
    expect(second.archive.restoreInto(second.lobby)).toEqual({ indexed: 1, replayed: 0, otherDeployment: 0, skipped: [] });
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

  it('never auto-settles a match whose archive file stopped replaying after the restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-archive-')); dirs.push(dir);
    const clock = { t: Date.now() };
    const first = await referee(dir, clock);
    const { id } = await concededMatch(first.url);

    const { settler, submitted } = fakeSettler();
    const second = await referee(dir, clock, { settler });
    expect(second.archive.restoreInto(second.lobby).indexed).toBe(1);
    // Edited on disk while the referee runs: the result no longer matches the moves.
    rewriteArchive(dir, id, (rec) => { rec.log.result.turns += 5; });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await second.lobby.settleDue();
    err.mockRestore();
    expect(submitted).toEqual([]);
    expect(r.failed).toEqual([{ matchId: id, error: expect.stringMatching(/could not be loaded and verified/) }]);
    expect(second.lobby.get(id).referee).toMatchObject({ state: 'failed', attempts: 3 });
    // Given up for good: not retried on every pass.
    expect((await second.lobby.settleDue()).failed).toEqual([]);
  }, 30_000);

  it('auto-settles an unloaded match once it reloads and verifies, and saves the outcome', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-archive-')); dirs.push(dir);
    const clock = { t: Date.now() };
    const { settler, submitted } = fakeSettler();
    const { lobby, url } = await referee(dir, clock, { settler, resultGraceSeconds: 600 });
    const { id } = await concededMatch(url);
    clock.t += 61_000;
    lobby.tick();
    expect(lobby.get(id).cold).toBeDefined();
    expect((await lobby.settleDue()).settled).toEqual([id]);
    expect(submitted).toEqual([id]);
    const onDisk = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as ArchivedMatch;
    expect(onDisk.referee).toMatchObject({ state: 'settled' });
  }, 30_000);

  it('refuses a result signature for a match it cannot load, instead of keeping it only in memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-archive-')); dirs.push(dir);
    const clock = { t: Date.now() };
    const { lobby, url } = await referee(dir, clock);
    const { a, id } = await concededMatch(url);
    clock.t += 61_000;
    lobby.tick();
    rmSync(join(dir, `${id}.json`));
    await expect(a.signResult(id)).rejects.toThrow(/500|could not be loaded/);
    expect(lobby.get(id).players[0].resultSig).toBeUndefined();
  }, 30_000);

  it('the bot loop only signs finished matches that are missing a house signature, and archives what it signs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-archive-')); dirs.push(dir);
    const clock = { t: Date.now() };
    const house = privateKeyToAccount(generatePrivateKey());
    let signed = 0;
    const counting = { ...house, signTypedData: (async (args: Parameters<typeof house.signTypedData>[0]) => { signed++; return house.signTypedData(args); }) as typeof house.signTypedData };
    const first = await referee(dir, clock, { house: counting });
    const { id } = await concededMatch(first.url);
    await new Promise((r) => setTimeout(r, 20)); // finish() signs asynchronously
    expect(first.lobby.get(id).refereeSig).toBeDefined();

    // Already signed: the loop does nothing, however many finished matches there are.
    signed = 0;
    await first.lobby.stepBots();
    expect(signed).toBe(0);

    // An archive without the referee signature (as if signing never happened): restored, signed by the loop, archived.
    const rec = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as ArchivedMatch;
    delete rec.refereeSig;
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(rec));
    const second = await referee(dir, clock, { house: counting });
    expect(second.lobby.restore(rec)).toBe(true);
    signed = 0;
    await second.lobby.stepBots();
    expect(signed).toBe(1);
    const onDisk = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as ArchivedMatch;
    expect(onDisk.refereeSig).toBe(second.lobby.get(id).refereeSig);
    expect(onDisk.refereeSig).toBeDefined();
    await second.lobby.stepBots();
    expect(signed).toBe(1);
  }, 30_000);

  it('does not restore an archive file edited before the restart so it no longer replays', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-archive-')); dirs.push(dir);
    const clock = { t: Date.now() };
    const first = await referee(dir, clock);
    const { id } = await concededMatch(first.url);
    const kept = await concededMatch(first.url);
    rewriteArchive(dir, id, (rec) => { rec.log.result.turns += 5; });

    const second = await referee(dir, clock);
    const report = second.archive.restoreInto(second.lobby);
    expect(report).toMatchObject({ indexed: 1, replayed: 0, skipped: [`${id}.json: does not replay to its signed result`] });
    expect(() => second.lobby.get(id)).toThrow(/no such match/);
    expect(second.lobby.list().map((x) => x.matchId)).toEqual([kept.id]);
  }, 30_000);

  it('migrates an archive without an index: replays every file once, then restarts from the index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-archive-')); dirs.push(dir);
    const clock = { t: Date.now() };
    const first = await referee(dir, clock);
    const ids = [(await finishedMatch(first.url)).id, (await concededMatch(first.url)).id];
    rmSync(join(dir, 'index.jsonl')); // as archived by a referee from before the index

    const second = await referee(dir, clock);
    expect(second.archive.restoreInto(second.lobby)).toMatchObject({ indexed: 0, replayed: 2 });
    expect(second.lobby.get(ids[0]).cold).toBeUndefined(); // replayed: loaded until the next tick unloads it
    clock.t += 1;
    second.lobby.tick();
    expect(ids.map((id) => !!second.lobby.get(id).cold)).toEqual([true, true]);
    expect(indexLines(dir)).toHaveLength(2);

    const third = await referee(dir, clock);
    expect(third.archive.restoreInto(third.lobby)).toMatchObject({ indexed: 2, replayed: 0 });
    expect(third.lobby.list()).toEqual(second.lobby.list());
  }, 30_000);

  it('replays a file that changed after its index line (a crash between the two writes), and indexes it again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-archive-')); dirs.push(dir);
    const clock = { t: Date.now() };
    const first = await referee(dir, clock);
    const { id } = await concededMatch(first.url);
    const other = await concededMatch(first.url);
    // The loser's signature reached the archive file, but the referee died before writing its index line.
    const loserSig = await other.a.signResult(other.id).then(() => first.lobby.get(other.id).players[0].resultSig!);
    rewriteArchive(dir, other.id, (rec) => { rec.resultSigs[0] = loserSig; });
    const lines = indexLines(dir);
    writeFileSync(join(dir, 'index.jsonl'), lines.filter((l) => !(l.includes(other.id) && l.includes(loserSig))).join('\n') + '\n');

    const second = await referee(dir, clock);
    expect(second.archive.restoreInto(second.lobby)).toMatchObject({ indexed: 1, replayed: 1 });
    expect(second.lobby.get(other.id).players[0].resultSig).toBe(loserSig);
    expect(second.lobby.get(id).cold).toBeDefined();
    const third = await referee(dir, clock);
    expect(third.archive.restoreInto(third.lobby)).toMatchObject({ indexed: 2, replayed: 0 });
    expect(third.lobby.get(other.id).players[0].resultSig).toBe(loserSig);
  }, 30_000);

  it('ignores a damaged index line, drops lines for deleted files, and keeps one line per match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-archive-')); dirs.push(dir);
    const clock = { t: Date.now() };
    const first = await referee(dir, clock);
    const { id } = await concededMatch(first.url);
    const gone = await concededMatch(first.url);
    await gone.a.signResult(gone.id); // a second line for this match
    rmSync(join(dir, `${gone.id}.json`));
    appendFileSync(join(dir, 'index.jsonl'), '{"v":1,"summary":{"log":{"matchId":"0x'); // cut short by a crash
    expect(indexLines(dir).length).toBeGreaterThan(2);

    const second = await referee(dir, clock);
    expect(second.archive.restoreInto(second.lobby)).toEqual({ indexed: 1, replayed: 0, otherDeployment: 0, skipped: [] });
    expect(second.lobby.list().map((x) => x.matchId)).toEqual([id]);
    expect(indexLines(dir).map((l) => JSON.parse(l).summary.log.matchId)).toEqual([id]);
  }, 30_000);

  it('compacts the index while running, so it stays proportional to the number of matches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-archive-')); dirs.push(dir);
    const clock = { t: Date.now() };
    const first = await referee(dir, clock);
    const { id } = await concededMatch(first.url);
    const rec = first.lobby.archive(id);
    for (let i = 0; i < 300; i++) first.archive.save(rec);
    expect(indexLines(dir).length).toBeLessThanOrEqual(2 * 1 + 101);
    const second = await referee(dir, clock);
    expect(second.archive.restoreInto(second.lobby)).toMatchObject({ indexed: 1, replayed: 0 });
    expect(indexLines(dir)).toHaveLength(1);
  }, 30_000);
});
