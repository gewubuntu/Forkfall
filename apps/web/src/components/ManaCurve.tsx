import { useEffect, useRef, useState } from 'react';

/**
 * Gas curve: how many cards cost 0, 1, … 7+. Single series → one validated hue (Base blue),
 * no legend; values on the column caps; hover tooltip per column; a table view for screen readers.
 */
export function ManaCurve({ costs }: { costs: number[] }) {
  const buckets = Array.from({ length: 8 }, (_, i) => costs.filter((c) => (i === 7 ? c >= 7 : c === i)).length);
  const max = Math.max(4, ...buckets);
  const [hover, setHover] = useState<number | null>(null);
  // Columns whose count just changed bounce and flash, so you see where each card landed.
  const prev = useRef(buckets);
  const changed = buckets.map((n, i) => n !== prev.current[i]);
  useEffect(() => { prev.current = buckets; });
  const label = (i: number) => (i === 7 ? '7+' : String(i));
  return (
    <figure className="curve">
      <figcaption>Gas curve</figcaption>
      <div className="curve-plot" role="img" aria-label={`Gas curve: ${buckets.map((n, i) => `${n} at ${label(i)}`).join(', ')}`}>
        {buckets.map((n, i) => (
          <div key={changed[i] ? `${i}-${n}` : i} className={`curve-col ${changed[i] ? (n > prev.current[i] ? 'up' : 'down') : ''}`} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span className="curve-val">{n || ''}</span>
            <span className="curve-bar" style={{ height: `${(n / max) * 100}%` }} />
            {hover === i && <span className="curve-tip" role="tooltip">{n} card{n === 1 ? '' : 's'} costing {label(i)} Gas</span>}
          </div>
        ))}
      </div>
      <div className="curve-axis" aria-hidden>{buckets.map((_, i) => <span key={i}>{label(i)}</span>)}</div>
      <table className="sr-only">
        <caption>Cards per Gas cost</caption>
        <thead><tr><th>Gas</th><th>Cards</th></tr></thead>
        <tbody>{buckets.map((n, i) => <tr key={i}><td>{label(i)}</td><td>{n}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}
