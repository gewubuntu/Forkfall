import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { summarize, type ArchivedMatch, type ArchiveSummary, type Lobby } from './lobby.ts';
import { writeFileAtomic } from './state.ts';

/** One line of index.jsonl: a match's summary and the size and mtime of the archive file it was taken from. */
interface IndexLine { v: 1; summary: ArchiveSummary; size: number; mtimeMs: number }

export interface RestoreReport {
  /** Restored unloaded from the index, without reading their archive file. */
  indexed: number;
  /** Read and replayed (verified): no index line, or the file changed since its line was written. */
  replayed: number;
  /** Signed for another deployment (same chain, different MatchSettlement): kept on disk, not loaded. */
  otherDeployment: number;
  /** Archive files that could not be read or did not replay, with why. */
  skipped: string[];
}

const ARCHIVE_FILE = /^(0x[0-9a-fA-F]{64})\.json$/;

/**
 * Whether a file is still the one its index line was written for: same size and mtime. Backups restored with tar
 * keep mtimes to the whole second only, so a whole-second mtime also matches a line from that same second (a file
 * the referee writes itself practically never lands on an exact second).
 */
function sameFile(line: IndexLine, st: { size: number; mtimeMs: number }): boolean {
  if (line.size !== st.size) return false;
  if (line.mtimeMs === st.mtimeMs) return true;
  return st.mtimeMs % 1000 === 0 && Math.floor(line.mtimeMs / 1000) * 1000 === st.mtimeMs;
}

/**
 * Finished matches on disk: one JSON file per match (the full signed log), plus index.jsonl, the summaries the
 * server wrote as it archived them. A restart reads the index and only lists the directory; a match is read and
 * replayed only when its file has no up-to-date line (a crash between the two writes, an edited file, an upgrade).
 * The index is a cache of the archive files: deleting it only costs one slow start.
 */
export class MatchArchive {
  readonly indexFile: string;
  /** Lines in index.jsonl, and the matches they cover: compacted when the lines are mostly superseded. */
  private lines = 0;
  private ids = new Set<string>();

  constructor(readonly dir: string) {
    this.indexFile = join(dir, 'index.jsonl');
  }

  private file(id: Hex) { return join(this.dir, `${id}.json`); }

  load(id: Hex): ArchivedMatch | null {
    try { return JSON.parse(readFileSync(this.file(id), 'utf8')) as ArchivedMatch; } catch { return null; }
  }

  /** Archive a finished match: its full record (atomically), then its summary line. Throws if the record isn't saved. */
  save(rec: ArchivedMatch) {
    const id = rec.log.matchId;
    writeFileAtomic(this.file(id), JSON.stringify(rec));
    try {
      const st = statSync(this.file(id));
      appendFileSync(this.indexFile, JSON.stringify({ v: 1, summary: summarize(rec), size: st.size, mtimeMs: st.mtimeMs } satisfies IndexLine) + '\n');
      this.lines++;
      this.ids.add(id.toLowerCase());
      if (this.lines > 2 * this.ids.size + 100) this.compact();
    } catch (e) {
      // The record is safe; without its line the next start just reads and replays this one file.
      console.error(`could not index archived match ${id}`, e);
    }
  }

  /** Index lines by match id (the last line for a match wins); damaged lines are ignored. */
  private readIndex(): { byId: Map<string, IndexLine>; lines: number } {
    const byId = new Map<string, IndexLine>();
    let lines = 0;
    let text = '';
    try { text = readFileSync(this.indexFile, 'utf8'); } catch { return { byId, lines }; }
    for (const raw of text.split('\n')) {
      if (!raw) continue;
      lines++;
      try {
        const line = JSON.parse(raw) as IndexLine;
        if (line.v === 1 && line.summary?.log?.matchId) byId.set(line.summary.log.matchId.toLowerCase(), line);
      } catch { /* a line cut short by a crash: that match is read from its file instead */ }
    }
    return { byId, lines };
  }

  private writeIndex(lines: IndexLine[]) {
    writeFileAtomic(this.indexFile, lines.map((l) => JSON.stringify(l) + '\n').join(''));
    this.lines = lines.length;
    this.ids = new Set(lines.map((l) => l.summary.log.matchId.toLowerCase()));
  }

  /** Rewrite the index with one line per match. */
  private compact() {
    this.writeIndex([...this.readIndex().byId.values()]);
  }

  /**
   * Load every archived match into the lobby: from the index when its line matches the file (size and mtime),
   * otherwise by reading and replaying the file. Then rewrite the index to exactly one current line per file.
   */
  restoreInto(lobby: Lobby): RestoreReport {
    const report: RestoreReport = { indexed: 0, replayed: 0, otherDeployment: 0, skipped: [] };
    if (!existsSync(this.dir)) return report;
    const index = this.readIndex();
    const fresh: IndexLine[] = [];
    let rebuilt = 0;
    for (const f of readdirSync(this.dir)) {
      const id = ARCHIVE_FILE.exec(f)?.[1] as Hex | undefined;
      if (!id) continue;
      let st;
      try { st = statSync(this.file(id)); } catch (e) { report.skipped.push(`${f}: ${(e as Error).message}`); continue; }
      const line = index.byId.get(id.toLowerCase());
      if (line && sameFile(line, st)) {
        if (lobby.restoreSummary(line.summary)) report.indexed++; else report.otherDeployment++;
        fresh.push(line);
        continue;
      }
      let rec: ArchivedMatch;
      try { rec = JSON.parse(readFileSync(this.file(id), 'utf8')) as ArchivedMatch; } catch (e) {
        report.skipped.push(`${f}: ${(e as Error).message}`);
        continue;
      }
      if (rec.log?.matchId?.toLowerCase() !== id.toLowerCase()) { report.skipped.push(`${f}: holds another match`); continue; }
      if (!lobby.ownDomain(rec.log.domain)) report.otherDeployment++;
      else if (lobby.restore(rec)) report.replayed++;
      else { report.skipped.push(`${f}: does not replay to its signed result`); continue; }
      fresh.push({ v: 1, summary: summarize(rec), size: st.size, mtimeMs: st.mtimeMs });
      rebuilt++;
    }
    // Rewrite when lines were added, or the file holds more than one current line per archive file (superseded,
    // damaged, or for files that are gone).
    if (rebuilt || index.lines !== fresh.length) {
      this.writeIndex(fresh);
    } else {
      this.lines = index.lines;
      this.ids = new Set(index.byId.keys());
    }
    return report;
  }
}
