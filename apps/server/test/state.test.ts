import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Profiles } from '../src/profiles.ts';
import { Quests } from '../src/quests.ts';
import { readJsonOrSetAside } from '../src/state.ts';

const ALICE = '0x00000000000000000000000000000000000a11ce';
const tmp = (name: string) => join(mkdtempSync(join(tmpdir(), 'ff-state-')), name);

describe('JSON stores survive a bad file', () => {
  it('reads a good file, falls back for a missing one', () => {
    const file = tmp('ok.json');
    expect(readJsonOrSetAside(file, () => ({ empty: true }))).toEqual({ empty: true });
    writeFileSync(file, '{"a":1}');
    expect(readJsonOrSetAside(file, () => ({}))).toEqual({ a: 1 });
  });

  it('moves a half-written file aside and starts empty', () => {
    const file = tmp('bad.json');
    writeFileSync(file, '{"0xabc": {"title": ');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(readJsonOrSetAside(file, () => ({}), () => 123)).toEqual({});
    err.mockRestore();
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.corrupt-123`, 'utf8')).toBe('{"0xabc": {"title": ');
  });

  it('throws and leaves the file in place when it cannot be read', () => {
    const path = tmp('dir.json');
    mkdirSync(path); // readFileSync fails with EISDIR, like EACCES on a file restored with the wrong owner
    expect(() => readJsonOrSetAside(path, () => ({}))).toThrow(/EISDIR/);
    expect(readdirSync(join(path, '..'))).toEqual(['dir.json']);
  });

  it('profiles and quests start (and save) over a corrupt file', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const profilesFile = tmp('profiles.json');
    writeFileSync(profilesFile, '{"truncated');
    const profiles = new Profiles(profilesFile);
    expect(profiles.completeLesson(ALICE).tutorial).toBe(true);
    expect(JSON.parse(readFileSync(profilesFile, 'utf8'))[ALICE].tutorial).toBe(true);

    const questsFile = tmp('quests.json');
    writeFileSync(questsFile, '');
    const quests = new Quests({ chainId: 31337, file: questsFile });
    expect(quests.hasSeen('0x01')).toBe(false);
    err.mockRestore();
    for (const f of [profilesFile, questsFile]) {
      expect(readdirSync(join(f, '..')).some((x) => x.includes('.corrupt-'))).toBe(true);
    }
  });
});
