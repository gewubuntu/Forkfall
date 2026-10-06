import { dayStartMs, questDay } from '@forkfall/engine';
import type { MetricsCohort, MetricsDay, MetricsGateRow, MetricsGroup, MetricsReport } from '@forkfall/sdk';
import { join } from 'node:path';
import type { FinishedMatch } from './quests.ts';
import { readJsonOrSetAside, writeFileAtomic } from './state.ts';

/** Where the alpha metrics are kept: apps/server/data/metrics/<chainId>.json. */
export const metricsFile = (root: string, chainId: number) => join(root, 'apps/server/data/metrics', `${chainId}.json`);

/** Cohorts (and gate samples) smaller than this show their size but no percentage, so one player can't be read off. */
export const MIN_COHORT = 5;
/** The gate is judged over this many complete days. */
export const GATE_DAYS = 14;
/** The alpha's gate before paid packs (GDD, "Alpha metrics"): proposed targets, tuned on the first weeks of data. */
export const GATE = {
  d1: { label: 'Day-1 retention', target: 0.35 },
  d7: { label: 'Day-7 retention', target: 0.12 },
  matches: { label: 'Matches per active player per day', target: 4 },
  packs: { label: 'Packs opened per active player per day', target: 1 },
  craft: { label: 'Active players who craft by day 7', target: 0.15 },
} as const;

const SEEN_LIMIT = 5000;
/** Per-day counters are kept this long; older ones are dropped (a wallet's own record is a few bytes and stays). */
const KEEP_DAYS = 400;
const MAX_DAYS = 90;
const CHUNK = 2000;
const CHUNKS_PER_POLL = 5;

interface Counts { matches: number; packs: number; crafts: number }
const zero = (): Counts => ({ matches: 0, packs: 0, crafts: 0 });

/** What the referee knows about a wallet: its first active day and a bitmap of its active days (bit i = day first+i). */
interface Wallet { first: number; bits: string; agent?: boolean }

interface Store {
  wallets: Record<string, Wallet>;
  /** First day each wallet crafted. */
  crafters: Record<string, number>;
  days: Record<string, { h: Counts; a: Counts }>;
  seen: string[];
  /** Last block whose pack and craft logs were counted. */
  cursor?: number;
}

/** A pack opened or a card crafted, from a chain log. */
export interface ChainEvent { kind: 'pack' | 'craft'; owner: string; /** ms */ at: number }
/** The chain as the metrics poller reads it. */
export interface MetricsChain {
  /** Where to start the first time (the deployment block). */
  startBlock: number;
  head(): Promise<number>;
  events(from: number, to: number): Promise<ChainEvent[]>;
}

export interface MetricsOptions { file?: string; now?: () => number; chain?: MetricsChain | null }

const lc = (a: string) => a.toLowerCase();

/**
 * The alpha's gate numbers. Fed by finished matches (the referee's `onChange`) and by `PackOpened` / `Crafted` chain
 * logs read from a block cursor. Stores per wallet only a first day and an active-day bitmap, plus per-day counters;
 * `report()` returns aggregates only.
 */
export class Metrics {
  private data: Store;
  readonly setAside: string | null;
  private now: () => number;
  private polling = false;

  constructor(private opts: MetricsOptions = {}) {
    const empty = (): Store => ({ wallets: {}, crafters: {}, days: {}, seen: [] });
    const valid = (x: Record<string, unknown>) => typeof x.wallets === 'object' && x.wallets !== null && typeof x.days === 'object' && x.days !== null && Array.isArray(x.seen);
    ({ data: this.data, setAside: this.setAside } = opts.file ? readJsonOrSetAside(opts.file, empty, { valid }) : { data: empty(), setAside: null });
    this.data.crafters ??= {};
    this.now = opts.now ?? Date.now;
  }

  get onchain() { return !!this.opts.chain; }

  // ─── Recording ───────────────────────────────────────────────
  /**
   * A finished match. Counts for each human seat, unless it is Practice (a house-bot seat outside Sealed). A Sealed match
   * against a house bot counts: for a player with an empty queue it is the real game. Counted once per match id.
   */
  record(m: FinishedMatch) {
    if (this.data.seen.includes(m.id)) return;
    const bots = m.players.filter((p) => p.bot);
    if (bots.length > 0 && m.format !== 'sealed') return;
    if (bots.length === m.players.length) return;
    this.data.seen.push(m.id);
    if (this.data.seen.length > SEEN_LIMIT) this.data.seen.splice(0, this.data.seen.length - SEEN_LIMIT);
    const day = questDay(m.endedAt);
    m.players.forEach((p, i) => {
      if (p.bot) return;
      const w = this.touch(p.address, day, !!m.agents?.[i]);
      this.counts(day, w.agent).matches++;
    });
    this.save();
  }

  /** Mark a wallet active on a day (creating its record), and return it. */
  private touch(address: string, day: number, agent: boolean): Wallet {
    const a = lc(address);
    let w = this.data.wallets[a];
    if (!w) w = this.data.wallets[a] = { first: day, bits: '1' };
    else {
      if (day < w.first) { w.bits = (BigInt('0x' + w.bits) << BigInt(w.first - day)).toString(16); w.first = day; }
      w.bits = (BigInt('0x' + w.bits) | (1n << BigInt(day - w.first))).toString(16);
    }
    if (agent) w.agent = true;
    return w;
  }

  private counts(day: number, agent?: boolean): Counts {
    const d = (this.data.days[day] ??= { h: zero(), a: zero() });
    return agent ? d.a : d.h;
  }

  /** Chain logs: packs opened and cards crafted, counted for the opener's group (agents have their own row). */
  private applyEvents(events: ChainEvent[]) {
    for (const e of events) {
      const day = questDay(e.at);
      const w = this.data.wallets[lc(e.owner)];
      const c = this.counts(day, w?.agent);
      if (e.kind === 'pack') c.packs++;
      else {
        c.crafts++;
        const a = lc(e.owner);
        if (this.data.crafters[a] === undefined || day < this.data.crafters[a]) this.data.crafters[a] = day;
      }
    }
  }

  /** Read new chain logs from the cursor (the first time, from the deployment block), a few chunks at a time. */
  async poll() {
    const chain = this.opts.chain;
    if (!chain || this.polling) return;
    this.polling = true;
    try {
      const head = await chain.head();
      for (let i = 0; i < CHUNKS_PER_POLL; i++) {
        const from = (this.data.cursor ?? chain.startBlock - 1) + 1;
        if (from > head) break;
        const to = Math.min(head, from + CHUNK - 1);
        const events = await chain.events(from, to);
        this.applyEvents(events);
        this.data.cursor = to; // counted and advanced together, saved together
        this.save();
      }
    } finally { this.polling = false; }
  }

  // ─── Reports ─────────────────────────────────────────────────
  private activeDays(w: Wallet): number[] {
    const out: number[] = [];
    const bits = BigInt('0x' + w.bits).toString(2);
    for (let i = 0; i < bits.length; i++) if (bits[bits.length - 1 - i] === '1') out.push(w.first + i);
    return out;
  }

  report(days = 30): MetricsReport {
    const span = Math.max(1, Math.min(MAX_DAYS, Math.floor(days) || 30));
    const today = questDay(this.now());
    const onchain = this.onchain;
    const walletsBy = (agent: boolean) => Object.entries(this.data.wallets)
      .filter(([, w]) => !!w.agent === agent)
      .map(([a, w]) => ({ a, w, active: new Set(this.activeDays(w)) }));
    const group = (agent: boolean): { g: MetricsGroup; rows: ReturnType<typeof walletsBy> } => {
      const rows = walletsBy(agent);
      const daily: MetricsDay[] = [];
      for (let d = today - span + 1; d <= today; d++) {
        const c = this.data.days[d]?.[agent ? 'a' : 'h'] ?? zero();
        const active = rows.filter((r) => r.active.has(d)).length;
        const newPlayers = rows.filter((r) => r.w.first === d).length;
        daily.push({
          day: d, at: dayStartMs(d), active, newPlayers, matches: c.matches,
          matchesPerActive: active ? c.matches / active : null,
          packs: onchain ? c.packs : null, packsPerActive: onchain && active ? c.packs / active : null, crafts: onchain ? c.crafts : null,
        });
      }
      const cohorts: MetricsCohort[] = [];
      for (let d = today - span + 1; d <= today; d++) {
        const members = rows.filter((r) => r.w.first === d);
        const size = members.length;
        // A rate needs a big-enough cohort and a finished comparison day (today is still being played).
        const rate = (pred: (r: (typeof members)[number]) => boolean, ready: boolean) =>
          size >= MIN_COHORT && ready ? members.filter(pred).length / size : null;
        cohorts.push({
          day: d, at: dayStartMs(d), size,
          d1: rate((r) => r.active.has(d + 1), d + 1 < today),
          d7: rate((r) => r.active.has(d + 7), d + 7 < today),
          week: rate((r) => [1, 2, 3, 4, 5, 6, 7].some((k) => r.active.has(d + k)), d + 7 < today),
          craftedByD7: onchain ? rate((r) => { const c = this.data.crafters[r.a]; return c !== undefined && c <= d + 7; }, d + 7 < today) : null,
        });
      }
      const crafted = onchain ? rows.filter((r) => this.data.crafters[r.a] !== undefined).length : null;
      const craftShare = { crafted: onchain && rows.length >= MIN_COHORT ? crafted : null, players: rows.length, rate: onchain && rows.length >= MIN_COHORT ? crafted! / rows.length : null };
      return { g: { daily, cohorts, craftShare }, rows };
    };
    const humans = group(false);
    const agents = group(true);
    return {
      generatedAt: this.now(), days: span, onchain, minCohort: MIN_COHORT,
      gate: this.gate(humans.rows, today),
      humans: humans.g, agents: agents.g,
    };
  }

  /** The gate over the last GATE_DAYS complete days (humans only). Weighted across cohorts and days, not an average of rates. */
  private gate(rows: { a: string; w: Wallet; active: Set<number> }[], today: number): MetricsReport['gate'] {
    const lo = today - GATE_DAYS;
    // Retention: cohorts first active in the window whose comparison day is complete.
    const cohort = (k: number, pred: (r: (typeof rows)[number], d: number) => boolean) => {
      const m = rows.filter((r) => r.w.first >= lo && r.w.first + k < today);
      return m.length >= MIN_COHORT ? m.filter((r) => pred(r, r.w.first)).length / m.length : null;
    };
    const d1 = cohort(1, (r, d) => r.active.has(d + 1));
    const d7 = cohort(7, (r, d) => r.active.has(d + 7));
    const craft = this.onchain ? cohort(7, (r, d) => { const c = this.data.crafters[r.a]; return c !== undefined && c <= d + 7; }) : null;
    let matches = 0; let packs = 0; let active = 0;
    for (let d = lo; d < today; d++) {
      const c = this.data.days[d]?.h;
      if (c) { matches += c.matches; packs += c.packs; }
      active += rows.filter((r) => r.active.has(d)).length;
    }
    const mpa = active >= MIN_COHORT ? matches / active : null;
    const ppa = this.onchain && active >= MIN_COHORT ? packs / active : null;
    const row = (id: MetricsGateRow['id'], value: number | null): MetricsGateRow =>
      ({ id, label: GATE[id].label, target: GATE[id].target, value, met: value === null ? null : value >= GATE[id].target });
    const out = [row('d1', d1), row('d7', d7), row('matches', mpa), row('packs', ppa), row('craft', craft)];
    const known = out.filter((r) => r.met !== null);
    return { days: GATE_DAYS, rows: out, passed: known.length === out.length ? known.every((r) => r.met) : null };
  }

  private memo = new Map<number, { at: number; report: MetricsReport }>();
  /** `report` for the public route: unauthenticated callers can't make the referee recompute it more than every 30 s. */
  cachedReport(days = 30): MetricsReport {
    const span = Math.max(1, Math.min(MAX_DAYS, Math.floor(days) || 30));
    const hit = this.memo.get(span);
    if (hit && this.now() - hit.at < 30_000) return hit.report;
    const report = this.report(span);
    this.memo.set(span, { at: this.now(), report });
    return report;
  }

  /** The daily numbers of both groups as CSV (no wallets). */
  csv(days = 30): string {
    const r = this.cachedReport(days);
    const lines = ['date,group,active,new_players,matches,matches_per_active,packs,packs_per_active,crafts'];
    const f = (n: number | null) => (n === null ? '' : String(Math.round(n * 1000) / 1000));
    for (const [name, g] of [['humans', r.humans], ['agents', r.agents]] as const) {
      for (const d of g.daily) {
        lines.push([new Date(d.at).toISOString().slice(0, 10), name, d.active, d.newPlayers, d.matches, f(d.matchesPerActive), f(d.packs), f(d.packsPerActive), f(d.crafts)].join(','));
      }
    }
    return lines.join('\n') + '\n';
  }

  private save() {
    this.prune();
    if (!this.opts.file) return;
    writeFileAtomic(this.opts.file, JSON.stringify(this.data));
  }

  private prune() {
    const cutoff = questDay(this.now()) - KEEP_DAYS;
    for (const k of Object.keys(this.data.days)) if (Number(k) < cutoff) delete this.data.days[k];
  }
}
