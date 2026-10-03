import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Small JSON files the referee keeps between restarts (running matches, the queue, challenges, sessions).
 * Every write is atomic (temp file + rename), so a crash mid-write leaves the previous version, never half a
 * file. Files hold match secrets (seed shares, deck salts) and session hashes: owner-only permissions.
 */
export class StateStore {
  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'matches'), { recursive: true, mode: 0o700 });
  }

  write(rel: string, data: unknown) {
    writeFileAtomic(join(this.dir, rel), JSON.stringify(data), 0o600);
  }

  /** Raw text (e.g. a record that couldn't be parsed, set aside for a human to look at). */
  writeRaw(rel: string, text: string) {
    writeFileAtomic(join(this.dir, rel), text, 0o600);
  }

  readRaw(rel: string): string | null {
    try { return readFileSync(join(this.dir, rel), 'utf8'); } catch { return null; }
  }

  read<T>(rel: string): T | null {
    try { return JSON.parse(readFileSync(join(this.dir, rel), 'utf8')) as T; } catch { return null; }
  }

  remove(rel: string) {
    rmSync(join(this.dir, rel), { force: true });
  }

  /** JSON files in a subdirectory (relative paths). */
  list(sub: string): string[] {
    try { return readdirSync(join(this.dir, sub)).filter((f) => f.endsWith('.json')).map((f) => join(sub, f)); } catch { return []; }
  }
}

/** Write a file so readers only ever see the old or the new version: temp file in the same directory, then rename. */
export function writeFileAtomic(path: string, text: string, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}
