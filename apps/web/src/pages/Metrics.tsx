import type { MetricsCohort, MetricsDay, MetricsGateRow, MetricsReport } from '@forkfall/sdk';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';

const SERVER = import.meta.env.VITE_SERVER_URL ?? '';
const WINDOWS = [14, 30, 90] as const;

const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);
const num = (n: number | null, d = 1) => (n === null ? '–' : n.toFixed(d).replace(/\.0+$/, ''));
const dayLabel = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmt = (r: MetricsGateRow) => (r.id === 'matches' || r.id === 'packs' ? num(r.value, 2) : pct(r.value));
const target = (r: MetricsGateRow) => (r.id === 'matches' || r.id === 'packs' ? `${r.target}` : `${Math.round(r.target * 100)}%`);

/** The alpha's gate numbers (GDD "Alpha metrics"). Public aggregates: no wallet, no sign-in. */
export function Metrics() {
  const [days, setDays] = useState<number>(30);
  const q = useQuery({
    queryKey: ['metrics', days],
    queryFn: async (): Promise<MetricsReport> => {
      const r = await fetch(`${SERVER}/v1/metrics?days=${days}`);
      if (!r.ok) throw new Error('metrics are not available on this server');
      return r.json();
    },
    refetchInterval: 60_000,
    retry: false,
  });
  const r = q.data;
  return (
    <div className="page metrics-page">
      <header className="mt-hero">
        <div>
          <span className="pass-kicker">Testnet alpha</span>
          <h1>Alpha numbers</h1>
          <p className="muted">
            How the alpha is doing against its gate before paid packs. Players only: no wallet ever appears here, and groups under {r?.minCohort ?? 5} show their size but no percentage.
            Practice against a house bot doesn’t count as playing.
          </p>
        </div>
        <div className="mt-controls">
          <div className="tabs" role="group" aria-label="Window">
            {WINDOWS.map((w) => <button key={w} className={days === w ? 'on' : ''} aria-pressed={days === w} onClick={() => setDays(w)}>{w} days</button>)}
          </div>
          <a className="btn btn-ghost" href={`${SERVER}/v1/metrics?days=${days}&format=csv`} download={`forkfall-metrics-${days}d.csv`}>Export CSV</a>
        </div>
      </header>
      {q.isLoading && <span className="spinner" aria-label="Loading" />}
      {q.isError && <div className="panel empty"><h2>No numbers here</h2><p>This server doesn’t publish metrics.</p></div>}
      {r && <Body r={r} />}
      <p className="eco-back"><Link className="btn btn-ghost" to="/">Back to Forkfall</Link></p>
    </div>
  );
}

function Body({ r }: { r: MetricsReport }) {
  const h = r.humans;
  const maxActive = Math.max(1, ...h.daily.map((d) => d.active));
  return (
    <>
      <section className="panel" aria-labelledby="mt-gate">
        <div className="mt-gate-head">
          <h2 id="mt-gate">The gate · last {r.gate.days} complete days</h2>
          <span className={`q-tag ${r.gate.passed ? 'ok' : r.gate.passed === false ? 'held' : 'pending'}`}>
            {r.gate.passed ? '✓ Gate met' : r.gate.passed === false ? 'Not yet' : 'Not enough data yet'}
          </span>
        </div>
        <ul className="mt-tiles">
          {r.gate.rows.map((g) => (
            <li key={g.id} className={`mt-tile ${g.met === null ? 'na' : g.met ? 'met' : 'miss'}`}>
              <span className="mt-label">{g.label}</span>
              <b>{r.onchain || (g.id !== 'packs' && g.id !== 'craft') ? fmt(g) : 'n/a'}</b>
              <span className="small muted">target {target(g)} · {g.met === null ? (r.onchain || (g.id !== 'packs' && g.id !== 'craft') ? 'not enough players yet' : 'needs a chain') : g.met ? '✓ met' : 'below'}</span>
            </li>
          ))}
        </ul>
        <p className="small muted">Targets are proposals, tuned on the first weeks of real data. Humans only; agents are below.</p>
      </section>

      <section className="panel" aria-labelledby="mt-active">
        <h2 id="mt-active">Active players per day</h2>
        <div className="mt-bars" role="img" aria-label={`Active players per day, from ${h.daily[0] ? dayLabel(h.daily[0].at) : ''}: ${h.daily.map((d) => d.active).join(', ')}`}>
          {h.daily.map((d) => <span key={d.day} className="mt-bar" title={`${dayLabel(d.at)}: ${d.active} active, ${d.newPlayers} new`} style={{ height: `${(d.active / maxActive) * 100}%` }} />)}
        </div>
        <div className="mt-axis small muted"><span>{h.daily[0] ? dayLabel(h.daily[0].at) : ''}</span><span>peak {maxActive}</span><span>{h.daily.length ? dayLabel(h.daily[h.daily.length - 1].at) : ''}</span></div>
      </section>

      <section className="panel" aria-labelledby="mt-coh">
        <h2 id="mt-coh">Retention by first day</h2>
        <div className="mt-scroll">
          <table className="mt-table">
            <thead><tr><th>First day</th><th>New</th><th>Day 1</th><th>Day 7</th><th>Within a week</th>{r.onchain && <th>Crafted by day 7</th>}</tr></thead>
            <tbody>{[...h.cohorts].reverse().filter((c) => c.size > 0).map((c) => <CohortRow key={c.day} c={c} onchain={r.onchain} min={r.minCohort} />)}</tbody>
          </table>
        </div>
        <p className="small muted">“–” means fewer than {r.minCohort} players, or the day isn’t over yet. {r.onchain && h.craftShare.rate !== null ? `All time, ${pct(h.craftShare.rate)} of ${h.craftShare.players} players have crafted.` : ''}</p>
      </section>

      <section className="panel" aria-labelledby="mt-daily">
        <h2 id="mt-daily">Per day</h2>
        <div className="mt-scroll">
          <table className="mt-table">
            <thead><tr><th>Day</th><th>Active</th><th>New</th><th>Matches</th><th>Per player</th>{r.onchain && <><th>Packs</th><th>Per player</th><th>Crafts</th></>}</tr></thead>
            <tbody>{[...h.daily].reverse().map((d) => <DayRow key={d.day} d={d} onchain={r.onchain} />)}</tbody>
          </table>
        </div>
      </section>

      <section className="panel" aria-labelledby="mt-agents">
        <h2 id="mt-agents">Agents</h2>
        <p className="small muted">Counted apart: an always-on agent plays many matches a day and would swamp the averages above.</p>
        <table className="mt-table">
          <thead><tr><th>Last {r.days} days</th><th>Active today</th><th>Matches</th><th>Players ever</th></tr></thead>
          <tbody><tr>
            <td>Agents</td>
            <td>{r.agents.daily[r.agents.daily.length - 1]?.active ?? 0}</td>
            <td>{r.agents.daily.reduce((s, d) => s + d.matches, 0)}</td>
            <td>{r.agents.craftShare.players}</td>
          </tr></tbody>
        </table>
      </section>
    </>
  );
}

function CohortRow({ c, onchain, min }: { c: MetricsCohort; onchain: boolean; min: number }) {
  const why = c.size < min ? `Fewer than ${min} players` : 'Not finished yet';
  const cell = (n: number | null) => <td title={n === null ? why : undefined}>{pct(n)}</td>;
  return <tr><td>{dayLabel(c.at)}</td><td>{c.size}</td>{cell(c.d1)}{cell(c.d7)}{cell(c.week)}{onchain && cell(c.craftedByD7)}</tr>;
}

function DayRow({ d, onchain }: { d: MetricsDay; onchain: boolean }) {
  return (
    <tr><td>{dayLabel(d.at)}</td><td>{d.active}</td><td>{d.newPlayers}</td><td>{d.matches}</td><td>{num(d.matchesPerActive)}</td>
      {onchain && <><td>{d.packs ?? '–'}</td><td>{num(d.packsPerActive, 2)}</td><td>{d.crafts ?? '–'}</td></>}</tr>
  );
}
