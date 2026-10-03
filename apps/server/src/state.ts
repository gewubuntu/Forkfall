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
    const p = join(this.dir, rel);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, p);
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
