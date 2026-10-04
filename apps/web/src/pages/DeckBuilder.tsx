import {
  card, COLLECTIBLE, decodeDeck, DECK_SIZE, encodeDeck, MAX_COPIES, MAX_LEGENDARIES_RANKED, MAX_LEGENDARY_COPIES, RACES,
  RANKED_RARITY_CAP, RARITY_POINTS, starterDeck, validateDeck, type CardDef, type Race,
} from '@forkfall/engine';
import { deckRegistryAbi } from '@forkfall/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { encodeAbiParameters, keccak256, parseEventLogs, type Address, type Hex } from 'viem';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useTx } from '../chain/Tx.tsx';
import { useHub } from '../chain/useHub.ts';
import { useMyDecks } from '../chain/useMyDecks.ts';
import { useOwned } from '../chain/useOwned.ts';
import { GameCard } from '../components/GameCard.tsx';
import { ManaCurve } from '../components/ManaCurve.tsx';
import { RACE_COLOR, RACE_INFO } from '../game/meta.ts';
import { deckName, setDeckName } from '../lib/deckNames.ts';
import { spriteSvg } from '../lib/art.ts';
import { useParticles } from '../lib/particles.ts';
import { sfx } from '../lib/sfx.ts';

const RACE_CODE: Record<Race, number> = { agents: 1, prophets: 2, brokers: 3, degens: 4 };
const limitOf = (c: CardDef) => (c.rarity === 'legendary' ? MAX_LEGENDARY_COPIES : MAX_COPIES);
const byCost = (a: CardDef, b: CardDef) => a.cost - b.cost || a.name.localeCompare(b.name);

/** Same id DeckRegistry derives: keccak256(abi.encode(owner, race, sortedIds)). */
function deckIdOf(owner: Address, race: Race, ids: number[]): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint8' }, { type: 'uint16[]' }], [owner, RACE_CODE[race], ids]));
}

export function DeckBuilder() {
  const { contracts } = useHub();
  const { me } = useAuth();
  const player = me!.address as Address;
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const tx = useTx();
  const { total, isLoading: ownedLoading } = useOwned(player);
  const { decks } = useMyDecks(player);

  const [race, setRace] = useState<Race>((params.get('race') as Race) || 'agents');
  const [counts, setCounts] = useState<Map<number, number>>(new Map());
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [hover, setHover] = useState<number | null>(null);
  const flyFrom = useRef<HTMLElement | null>(null);
  const { ref: confettiRef, burst } = useParticles();
  const [seeded, setSeeded] = useState(false);
  const [importing, setImporting] = useState(() => params.has('import'));
  const [codeText, setCodeText] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /** Open a shared deck code: its race and cards replace the current list. */
  const importCode = (text: string): boolean => {
    try {
      const d = decodeDeck(text);
      setRace(d.race);
      setCounts(toCounts(d.cards));
      setName(`Imported ${RACE_INFO[d.race].name} deck`);
      setCodeError(null);
      return true;
    } catch (e) {
      setCodeError((e as Error).message);
      return false;
    }
  };

  // Start from an existing deck (?from=<deckId>), a shared deck code (?code=FF…) or a starter list (?starter=1).
  const from = params.get('from');
  useEffect(() => {
    if (seeded) return;
    const code = params.get('code');
    if (code) {
      if (!importCode(code)) setImporting(true);
      setCodeText(code);
      setSeeded(true);
    } else if (from) {
      const d = decks.find((x) => x.id.toLowerCase() === from.toLowerCase());
      if (!d) return;
      setRace(d.race);
      setCounts(toCounts(d.cardIds));
      setName(`${deckName(d.id, d.race)} (edit)`);
      setSeeded(true);
    } else {
      if (params.get('starter')) setCounts(toCounts(starterDeck(race)));
      setSeeded(true);
    }
  }, [from, decks, seeded, params, race]);

  const list = useMemo(() => [...counts.entries()].flatMap(([id, n]) => Array(n).fill(id) as number[]).sort((a, b) => a - b), [counts]);
  const size = list.length;
  const check = validateDeck(race, list, true);
  const points = list.reduce((a, id) => a + RARITY_POINTS[card(id).rarity], 0);
  const legendaries = list.filter((id) => card(id).rarity === 'legendary').length;
  const missing = [...counts.entries()].filter(([id, n]) => n > total(id));
  const sizeOk = size === DECK_SIZE;
  const ownedOk = missing.length === 0;
  const rankedOk = points <= RANKED_RARITY_CAP && legendaries <= MAX_LEGENDARIES_RANKED;
  const structural = validateDeck(race, list, false);
  const registrable = sizeOk && structural.ok && ownedOk && !ownedLoading;
  const existing = registrable ? decks.find((d) => d.id === deckIdOf(player, race, list)) : undefined;

  const pool = COLLECTIBLE.filter((c) => (c.faction === race || c.faction === 'neutral')
    && (!query || c.name.toLowerCase().includes(query.toLowerCase()) || c.text.toLowerCase().includes(query.toLowerCase()))).sort(byCost);

  const add = (id: number) => {
    setCounts((m) => { const n = new Map(m); n.set(id, (n.get(id) ?? 0) + 1); return n; });
    const from = flyFrom.current;
    flyFrom.current = null;
    sfx.deal(1);
    requestAnimationFrame(() => flyIntoDeck(id, from));
  };
  const remove = (id: number) => {
    setCounts((m) => { const n = new Map(m); const v = (n.get(id) ?? 0) - 1; if (v <= 0) n.delete(id); else n.set(id, v); return n; });
    sfx.attack();
    pulseRow(id, 'minus');
  };

  // Deck complete and valid: a small celebration once per completion.
  const wasReady = useRef(registrable);
  useEffect(() => {
    if (registrable && !wasReady.current) {
      sfx.done();
      const r = document.querySelector('.deck-panel .meters')?.getBoundingClientRect();
      if (r) burst(r.left + r.width / 2, r.top + r.height / 2, ['#3ecf8e', '#b6f23c', '#7dd3fc', '#ffffff'], 60, 7);
    }
    wasReady.current = registrable;
  }, [registrable, burst]);
  const addBlock = (c: CardDef): string | null => {
    const inDeck = counts.get(c.id) ?? 0;
    if (size >= DECK_SIZE) return 'Deck is full (30 cards).';
    if (inDeck >= limitOf(c)) return c.rarity === 'legendary' ? 'Max 1 copy of a Legendary.' : 'Max 2 copies per card.';
    if (inDeck >= total(c.id)) return total(c.id) === 0 ? 'You don’t own this card yet.' : `You own ${total(c.id)}.`;
    return null;
  };

  const changeRace = (r: Race) => {
    if (r === race) return;
    setRace(r);
    // Keep neutrals, drop the old race's cards.
    setCounts((m) => new Map([...m].filter(([id]) => card(id).faction === 'neutral')));
  };

  const register = async () => {
    const rc = await tx.run('Register deck', { address: contracts!.DeckRegistry, abi: deckRegistryAbi, functionName: 'register', args: [RACE_CODE[race], list] });
    if (!rc) return;
    const ev = parseEventLogs({ abi: deckRegistryAbi, logs: rc.logs }).find((l) => l.eventName === 'DeckRegistered');
    const id = ev && ev.eventName === 'DeckRegistered' ? ev.args.deckId : deckIdOf(player, race, list);
    setDeckName(id, name || `${RACE_INFO[race].name} deck`);
    await qc.invalidateQueries();
    navigate(`/decks?new=${id}`);
  };

  const rows = [...counts.entries()].map(([id, n]) => ({ c: card(id), n })).sort((a, b) => byCost(a.c, b.c));

  return (
    <div className="page builder">
      <canvas ref={confettiRef} className="particles" aria-hidden />
      <div className="builder-head">
        <div>
          <Link className="back" to="/decks">← Decks</Link>
          <h1>Deck builder</h1>
        </div>
        <div className="race-switch" role="radiogroup" aria-label="Race">
          {RACES.map((r) => (
            <button key={r} role="radio" aria-checked={race === r} className={race === r ? 'on' : ''} style={{ ['--rc' as string]: RACE_COLOR[r] }}
              onClick={() => changeRace(r)} aria-label={RACE_INFO[r].name}>
              <img src={spriteSvg(RACE_INFO[r].sprite)} alt="" /><span>{RACE_INFO[r].name}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="builder-grid">
        <section className="pool" aria-label="Card pool">
          <div className="pool-tools">
            <input type="search" placeholder="Search cards…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search cards" />
            <button className="btn" onClick={() => setCounts(toCounts(starterDeck(race)))}>Load starter list</button>
            <button className="btn btn-ghost" onClick={() => setCounts(new Map())} disabled={size === 0}>Clear</button>
            <button className="btn btn-ghost" onClick={() => setImporting((v) => !v)} aria-expanded={importing}>Import code</button>
          </div>
          {importing && (
            <form className="code-import" onSubmit={(e) => { e.preventDefault(); if (importCode(codeText)) setImporting(false); }}>
              <input value={codeText} onChange={(e) => { setCodeText(e.target.value); setCodeError(null); }} placeholder="Paste a deck code (FF…)"
                aria-label="Deck code" aria-invalid={!!codeError} autoFocus spellCheck={false} />
              <button className="btn btn-primary" disabled={!codeText.trim()}>Open deck</button>
            </form>
          )}
          {codeError && <div className="alert err" role="alert">{codeError}</div>}
          <div className="pool-grid">
            {pool.map((c) => {
              const inDeck = counts.get(c.id) ?? 0;
              const block = addBlock(c);
              return (
                <div key={c.id} className={`pool-cell ${total(c.id) === 0 ? 'unowned' : ''}`}
                  onClickCapture={(e) => { flyFrom.current = (e.currentTarget as HTMLElement).querySelector('.gcard'); }}>
                  <GameCard cardId={c.id} size="hand" dimmed={!!block && inDeck === 0} onHover={setHover}
                    onClick={block ? undefined : () => add(c.id)} label={`${c.name}: ${block ?? 'add to deck'}`} />
                  <div className="pool-meta">
                    <span className={`in-deck ${inDeck ? 'on' : ''}`} title="In deck / max copies">{inDeck}/{limitOf(c)}</span>
                    <span className="muted small">own {total(c.id)}</span>
                    {inDeck > 0 && <button className="mini-btn" onClick={() => remove(c.id)} aria-label={`Remove ${c.name}`}>−</button>}
                  </div>
                  {block && <span className="pool-why">{block}</span>}
                </div>
              );
            })}
          </div>
        </section>

        <aside className="deck-panel" aria-label="Your deck">
          <input className="deck-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`${RACE_INFO[race].name} deck`} aria-label="Deck name" maxLength={40} />
          <div className="meters">
            <Meter label="Cards" value={size} max={DECK_SIZE} ok={sizeOk} exact />
            <Meter label="Ranked budget" value={points} max={RANKED_RARITY_CAP} ok={rankedOk} />
          </div>
          <ManaCurve costs={list.map((id) => card(id).cost)} />
          <ul className="checks">
            <Check ok={sizeOk}>Exactly 30 cards {sizeOk ? '' : `(${size < DECK_SIZE ? `${DECK_SIZE - size} to go` : `${size - DECK_SIZE} too many`})`}</Check>
            <Check ok={structural.errors.filter((e) => !/must have/.test(e)).length === 0}>{RACE_INFO[race].name} + neutral cards, copy limits</Check>
            <Check ok={ownedOk}>{ownedOk ? 'You own every card' : `Missing ${missing.map(([id, n]) => `${n - total(id)}× ${card(id).name}`).join(', ')}`}</Check>
            <Check ok={rankedOk} warn>{rankedOk ? 'Ranked-legal' : `Casual only: ${points > RANKED_RARITY_CAP ? `${points}/${RANKED_RARITY_CAP} rarity points` : 'more than 1 Legendary'}`}</Check>
          </ul>
          <ol className="deck-list">
            {rows.length === 0 && <li className="muted">Click cards on the left to add them.</li>}
            {rows.map(({ c, n }) => (
              <li key={c.id} data-dl={c.id} className={n > total(c.id) ? 'short' : ''} onMouseEnter={() => setHover(c.id)} onMouseLeave={() => setHover(null)}
                style={{ ['--rc' as string]: RACE_COLOR[c.faction] }}>
                <span className="dl-cost">{c.cost}</span>
                <span className={`dl-name r-${c.rarity}`}>{c.name}</span>
                <span className="dl-n" key={n}>×{n}</span>
                <button className="mini-btn" onClick={() => remove(c.id)} aria-label={`Remove one ${c.name}`}>−</button>
                <button className="mini-btn" onClick={() => add(c.id)} disabled={!!addBlock(c)} aria-label={`Add one ${c.name}`}>+</button>
              </li>
            ))}
          </ol>
          <button className="btn btn-block" disabled={size === 0} onClick={async () => {
            try { await navigator.clipboard.writeText(encodeDeck(race, list)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
          }}>{copied ? 'Deck code copied ✓' : 'Copy deck code'}</button>
          {existing ? (
            <div className="alert info"><span>This exact deck is already registered as “{deckName(existing.id, existing.race)}”.</span></div>
          ) : (
            <button className="btn btn-primary btn-block btn-lg" disabled={!registrable || tx.busy || !contracts} onClick={register}>
              Register deck on-chain
            </button>
          )}
          <p className="muted small">Registering stores the card list in DeckRegistry ({check.ok ? 'ranked-legal' : 'casual'}). Ownership is checked again when you queue and when a match settles.</p>
          {hover !== null && <div className="hover-preview" aria-hidden><GameCard cardId={hover} size="preview" /></div>}
        </aside>
      </div>
    </div>
  );
}

function toCounts(ids: number[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
  return m;
}

function Meter({ label, value, max, ok, exact }: { label: string; value: number; max: number; ok: boolean; exact?: boolean }) {
  const over = value > max;
  return (
    <div className={`meter ${ok ? 'ok' : over ? 'over' : ''}`}>
      <div className="meter-top"><span>{label}</span><b>{value} / {max}</b></div>
      <div className="meter-bar" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
        <i style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
      </div>
      {exact && !ok && !over && <span className="sr-only">needs exactly {max}</span>}
    </div>
  );
}

function Check({ ok, warn, children }: { ok: boolean; warn?: boolean; children: React.ReactNode }) {
  return <li className={ok ? 'ok' : warn ? 'warn' : 'bad'}><span aria-hidden>{ok ? '✓' : warn ? '!' : '✕'}</span><span>{children}</span></li>;
}

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function pulseRow(id: number, kind: 'plus' | 'minus') {
  const row = document.querySelector<HTMLElement>(`.deck-list [data-dl="${id}"]`);
  row?.animate(kind === 'plus'
    ? [{ background: 'rgba(62, 207, 142, .35)' }, { background: 'transparent' }]
    : [{ background: 'rgba(255, 93, 115, .35)', transform: 'translateX(-4px)' }, { transform: 'translateX(3px)' }, { background: 'transparent', transform: 'none' }],
  { duration: 450, easing: 'ease-out' });
}

/** A copy of the card's art flies from the pool into its row in the deck list, then the row flashes. */
function flyIntoDeck(id: number, from: HTMLElement | null) {
  const to = document.querySelector<HTMLElement>(`.deck-list [data-dl="${id}"]`);
  if (!from || !to || reducedMotion()) { pulseRow(id, 'plus'); return; }
  const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
  const img = document.createElement('img');
  img.src = spriteSvg(id);
  img.className = 'fly-card';
  Object.assign(img.style, { left: `${a.left + a.width / 2 - 40}px`, top: `${a.top + 20}px` });
  document.body.appendChild(img);
  const dx = b.left + 30 - (a.left + a.width / 2 - 40), dy = b.top + b.height / 2 - 40 - (a.top + 20);
  const anim = img.animate([
    { transform: 'translate(0, 0) scale(1) rotate(0)', opacity: 1 },
    { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 60}px) scale(.8) rotate(-10deg)`, opacity: 1, offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) scale(.3) rotate(0)`, opacity: 0.2 },
  ], { duration: 520, easing: 'cubic-bezier(.4,.1,.3,1)' });
  anim.onfinish = () => { img.remove(); pulseRow(id, 'plus'); };
}
