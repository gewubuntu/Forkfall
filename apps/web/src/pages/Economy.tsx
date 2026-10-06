import { useEffect, useRef, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

/**
 * The token flywheel, stage by stage (GDD "Token flywheel"). Public: no wallet or server needed.
 * A planned design shown for transparency, not an offer: no token exists yet, and every stage after the testnet
 * waits for its gate (audit, legal review).
 */

type StageId = 1 | 2 | 3 | 4;

interface Stage {
  id: StageId;
  name: string;
  when: string;
  summary: string;
  runs: string[];
  moneyIn: string;
  moneyOut: string;
  gate: string;
}

const STAGES: Stage[] = [
  {
    id: 1, name: 'Testnet alpha', when: 'Now',
    summary: 'The game loop with no real money: prove it is fun before anything costs anything.',
    runs: ['Free play: practice, casual, ranked, friend challenges', 'Daily quests, Scrap and free packs', 'Crafting, cosmetics and shareable pulls', 'Agent League with test USDC', 'The Poncho collab set'],
    moneyIn: 'Nothing real: test tokens only.',
    moneyOut: 'Nothing real.',
    gate: 'People keep playing without rewards, the races balance at 45–55%, the contracts pass an audit, and a legal review clears paid packs, prize pools and entry fees.',
  },
  {
    id: 2, name: 'Mainnet beta', when: 'After audit + legal review',
    summary: 'Real packs, real prizes. Every prize is paid from what came in, never printed.',
    runs: ['Packs for ETH and USDC', 'Ranked season prize pools', 'Agent League entry fees via x402', 'Marketplace with a 5% royalty'],
    moneyIn: 'Pack sales, Agent League fees, marketplace royalties.',
    moneyOut: 'Season pools for verified humans and registered agents, weekly league pots, operations.',
    gate: 'Steady pack revenue, a liquidity plan, and a legal review of the token (MiCA in the EU and the other markets we serve).',
  },
  {
    id: 3, name: 'Token on Bankr', when: 'After a token legal review',
    summary: 'The token joins the loop as something you spend, not something you farm.',
    runs: ['Token launch via Bankr on Base, paired with WETH', 'Packs about 10% cheaper in the token', 'Token spent on Legendary crafting is burned', 'Part of pack revenue buys the token back for prizes', 'Swap fees fund prize pools and agent compute', 'Forkfall Bankr skill: play, queue and buy packs by prompt'],
    moneyIn: 'Everything from stage 2, plus swap fees and token spending.',
    moneyOut: 'Everything from stage 2, plus buyback and burn.',
    gate: 'A security review of Robinhood Chain, and partner agreements for collab sets.',
  },
  {
    id: 4, name: 'Cross-chain + collabs', when: 'After a chain security review',
    summary: 'More communities, more chains, one loop.',
    runs: ['Token and cards bridged to Robinhood Chain (LayerZero)', 'Collab sets with their own boosters and a buyback share', 'Legendary vaults and tournaments'],
    moneyIn: 'Everything from stage 3, plus collab boosters and cross-chain volume.',
    moneyOut: 'Everything from stage 3, plus collab buybacks.',
    gate: 'Every new chain or partner gets its own review.',
  },
];

interface Node { key: string; title: string; from: StageId; color: string; caption: (s: StageId) => string }

/** The loop, in order. Each part switches on at its stage. */
const NODES: Node[] = [
  { key: 'play', title: 'Play free', from: 1, color: 'var(--agents)', caption: () => 'Free starter decks, practice, ranked and friend matches. Never needs the token.' },
  { key: 'quests', title: 'Quests', from: 1, color: 'var(--brokers)', caption: () => 'Daily quests pay Scrap and free packs. Rewards go to verified humans and registered agents.' },
  { key: 'packs', title: 'Packs', from: 1, color: 'var(--prophets)', caption: (s) => s === 1 ? 'Test packs with verifiable randomness (Chainlink VRF on networks that have it).' : s === 2 ? 'Packs for ETH and USDC.' : 'Packs for ETH, USDC, or the token at about 10% off.' },
  { key: 'pools', title: 'Prize pools', from: 2, color: 'var(--warn)', caption: (s) => s === 2 ? 'Season pools funded by pack revenue.' : 'Season pools funded by pack revenue and swap fees.' },
  { key: 'league', title: 'Agent League', from: 1, color: 'var(--agents)', caption: (s) => s === 1 ? 'Agents compete for a weekly pot in test USDC.' : 'Agents pay a small entry fee (x402): 80% weekly pot, 10% buyback, 10% ops.' },
  { key: 'burn', title: 'Buyback + burn', from: 3, color: 'var(--danger)', caption: () => '20% of pack revenue buys the token back: half funds the season pool, half is burned. Token spent on Legendary crafting is burned.' },
  { key: 'swap', title: 'Bankr pool', from: 3, color: 'var(--rh-2)', caption: () => 'Trading on the Bankr pool earns the creator share of swap fees, which tops up prizes and agent compute.' },
  { key: 'collab', title: 'Collab sets', from: 1, color: 'var(--poncho)', caption: (s) => s < 4 ? 'Partner sets like Poncho bring their communities in.' : 'Each collab booster carries a buyback share.' },
  { key: 'chain', title: 'Cross-chain', from: 4, color: 'var(--rh)', caption: () => 'Token and cards bridged to Robinhood Chain: one loop on two chains.' },
];

const SPLITS = [
  { label: 'Operations and development', pct: 50, color: 'var(--line-2)' },
  { label: 'Prize pools', pct: 30, color: 'var(--warn)' },
  { label: 'Token buyback (half burned)', pct: 20, color: 'var(--danger)' },
];

const RULES = [
  ['Never required', 'Free starter decks stay, and packs always sell for ETH and USDC too.'],
  ['No yield', 'No staking rewards and no revenue share for holders: the token is for using, not for holding.'],
  ['No token emissions', 'Fixed supply at launch, and no token is paid out for playing. Token rewards come only from pools that revenue filled; quests give game items on a daily budget.'],
  ['Real players only', 'Rewards go to verified humans and registered agents: the referee checks the on-chain registries before paying.'],
  ['Public splits', 'Every split will live in a contract anyone can read. The Agent League\'s 80/10/10 already does.'],
];

function stageFromHash(hash: string): StageId {
  const m = /^#stage-([1-4])$/.exec(hash);
  return m ? (Number(m[1]) as StageId) : 1;
}

export function Economy() {
  const { hash } = useLocation();
  const navigate = useNavigate();
  const stage = stageFromHash(hash);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => { scrollTo(0, 0); }, []);
  const pick = (s: StageId, focus = false) => {
    navigate({ hash: `#stage-${s}` }, { replace: true });
    if (focus) tabs.current[s - 1]?.focus();
  };
  // Tabs pattern: one tab stop; arrows, Home and End move between stages.
  const onKey = (e: KeyboardEvent) => {
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (stage % 4) + 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? ((stage + 2) % 4) + 1
      : e.key === 'Home' ? 1 : e.key === 'End' ? 4 : 0;
    if (!next) return;
    e.preventDefault();
    pick(next as StageId, true);
  };
  const st = STAGES[stage - 1];

  return (
    <div className="page economy">
      <header className="eco-head">
        <div className="eco-eyebrow">Economy</div>
        <h1>The Forkfall flywheel</h1>
        <p className="lead">Rewards are paid from revenue, never printed. The token is something you spend in the game, and you never need it to play. Pick a stage to see which parts of the loop run.</p>
      </header>

      <div className="eco-tabs" role="tablist" aria-label="Stage" onKeyDown={onKey}>
        {STAGES.map((s, i) => (
          <button key={s.id} role="tab" id={`tab-${s.id}`} aria-selected={stage === s.id} aria-controls="eco-panel"
            tabIndex={stage === s.id ? 0 : -1} ref={(el) => { tabs.current[i] = el; }}
            className={`eco-tab ${stage === s.id ? 'on' : ''}`} onClick={() => pick(s.id)}>
            <span className="n">{s.id}</span>
            <span><b>{s.name}</b><small>{s.when}</small></span>
          </button>
        ))}
      </div>

      <section id="eco-panel" role="tabpanel" aria-labelledby={`tab-${stage}`} className="eco-body">
        <div className="eco-wheel-col">
          <Wheel stage={stage} />
        </div>
        <div className="eco-detail">
          <h2>Stage {st.id} · {st.name}</h2>
          <p className="eco-summary">{st.summary}</p>
          <ul className="eco-parts">
            {NODES.map((n) => {
              const on = n.from <= stage;
              return (
                <li key={n.key} className={on ? 'on' : 'off'} style={{ ['--nc' as string]: n.color }}>
                  <span className="dot" aria-hidden />
                  <div>
                    <b>{n.title}</b>{!on && <span className="later">from stage {n.from}</span>}
                    <p>{n.caption(stage)}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section className="eco-flows" aria-label={`Stage ${st.id} money flows`}>
        <div className="panel"><h3>Money in</h3><p>{st.moneyIn}</p></div>
        <div className="panel"><h3>Money out</h3><p>{st.moneyOut}</p></div>
        <div className="panel eco-gate"><h3>Gate to {stage < 4 ? `stage ${stage + 1}` : 'more'}</h3><p>{st.gate}</p></div>
      </section>

      {stage >= 3 && (
        <section className="panel eco-splits" aria-label="Where pack revenue goes">
          <h3>Where pack revenue goes <span className="muted">(starting values, tuned in playtests)</span></h3>
          <div className="bar" role="img" aria-label={SPLITS.map((x) => `${x.label} ${x.pct}%`).join(', ')}>
            {SPLITS.map((x) => <span key={x.label} style={{ width: `${x.pct}%`, background: x.color }} />)}
          </div>
          <ul className="legend">
            {SPLITS.map((x) => <li key={x.label}><span className="sw" style={{ background: x.color }} />{x.label} <b>{x.pct}%</b></li>)}
          </ul>
        </section>
      )}

      <section className="eco-rules">
        <h2>Five rules that keep it alive</h2>
        <div className="eco-rule-grid">
          {RULES.map(([t, d]) => <div className="panel" key={t}><h3>{t}</h3><p>{d}</p></div>)}
        </div>
      </section>

      <p className="eco-disclaimer">
        This is a planned design, shown for transparency. No Forkfall token exists yet, nothing here is an offer, and nothing
        promises a return. Each stage after the testnet starts only after its review. Today everything runs on testnet,
        with no real value.
      </p>
      <p className="eco-back"><Link className="btn btn-ghost" to="/metrics">Live alpha numbers</Link> <Link className="btn btn-ghost" to="/">Back to Forkfall</Link></p>
    </div>
  );
}

/** The loop as a ring: parts that run in this stage are lit, later ones are dimmed. */
function Wheel({ stage }: { stage: StageId }) {
  const C = 300, R = 215, NR = 50;
  const pts = NODES.map((_, i) => {
    const a = -Math.PI / 2 + (i / NODES.length) * Math.PI * 2;
    return { x: C + R * Math.cos(a), y: C + R * Math.sin(a), a };
  });
  // Arc from just after node i to just before node i+1, along the ring.
  const gap = (NR + 10) / R;
  const arcs = NODES.map((n, i) => {
    const j = (i + 1) % NODES.length;
    const a0 = pts[i].a + gap;
    const a1 = pts[j].a - gap + (j === 0 ? Math.PI * 2 : 0);
    const p0 = { x: C + R * Math.cos(a0), y: C + R * Math.sin(a0) };
    const p1 = { x: C + R * Math.cos(a1), y: C + R * Math.sin(a1) };
    const on = n.from <= stage && NODES[j].from <= stage;
    return { d: `M ${p0.x} ${p0.y} A ${R} ${R} 0 0 1 ${p1.x} ${p1.y}`, on, key: `${n.key}-${NODES[j].key}` };
  });
  const st = STAGES[stage - 1];
  return (
    <svg className="eco-wheel" viewBox="0 0 600 600" role="img"
      aria-label={`Flywheel at stage ${stage}: ${NODES.filter((n) => n.from <= stage).map((n) => n.title).join(', ')} are running.`}>
      <defs>
        <marker id="eco-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--text)" />
        </marker>
        <marker id="eco-arrow-off" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--line-2)" />
        </marker>
      </defs>
      <circle cx={C} cy={C} r={R} fill="none" stroke="var(--line)" strokeWidth="1" />
      {arcs.map((a) => (
        <path key={a.key} d={a.d} fill="none" className={a.on ? 'arc on' : 'arc'}
          stroke={a.on ? 'var(--text)' : 'var(--line-2)'} strokeWidth={a.on ? 2.5 : 1.5}
          markerEnd={a.on ? 'url(#eco-arrow)' : 'url(#eco-arrow-off)'} />
      ))}
      {NODES.map((n, i) => {
        const on = n.from <= stage;
        const p = pts[i];
        const words = n.title.split(' ');
        const lines = words.length > 1 && n.title.length > 10 ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : [n.title];
        return (
          <g key={n.key} className={on ? 'node on' : 'node off'}>
            <circle cx={p.x} cy={p.y} r={NR} fill={on ? 'var(--panel-2)' : 'var(--bg-2)'}
              stroke={on ? n.color : 'var(--line-2)'} strokeWidth={on ? 3 : 1.5} strokeDasharray={on ? undefined : '5 5'} />
            {lines.map((l, k) => (
              <text key={k} x={p.x} y={p.y + (k - (lines.length - 1) / 2) * 17 + 5} textAnchor="middle"
                fill={on ? 'var(--text)' : 'var(--dim)'} fontSize="15" fontWeight="700">{l}</text>
            ))}
            {!on && <text x={p.x} y={p.y + NR + 18} textAnchor="middle" fill="var(--dim)" fontSize="12">stage {n.from}</text>}
          </g>
        );
      })}
      <text x={C} y={C - 22} textAnchor="middle" fill="var(--muted)" fontSize="15" letterSpacing="2">STAGE {stage}</text>
      <text x={C} y={C + 12} textAnchor="middle" fill="var(--text)" fontSize="26" fontWeight="700" className="pixel">{st.name}</text>
      <text x={C} y={C + 42} textAnchor="middle" fill="var(--muted)" fontSize="14">{NODES.filter((n) => n.from <= stage).length} of {NODES.length} parts running</text>
    </svg>
  );
}
