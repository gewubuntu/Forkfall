import { card, encodeDeck, RACES } from '@forkfall/engine';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { Address } from 'viem';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useHub } from '../chain/useHub.ts';
import { useMyDecks, type MyDeck } from '../chain/useMyDecks.ts';
import { ManaCurve } from '../components/ManaCurve.tsx';
import { RACE_COLOR, RACE_INFO } from '../game/meta.ts';
import { deckName, setDeckName } from '../lib/deckNames.ts';
import { spriteSvg } from '../lib/art.ts';
import { shortAddr } from '../lib/format.ts';

export function Decks() {
  const { contracts } = useHub();
  const { me } = useAuth();
  const { decks, isLoading, error } = useMyDecks(me?.address as Address);
  const [params] = useSearchParams();
  const fresh = params.get('new');

  if (!contracts) {
    return (
      <div className="page"><div className="panel empty">
        <h2>Decks aren’t live yet</h2>
        <p>Deck registration needs the hub contracts, which aren’t deployed here (or the referee runs off-chain). Casual and practice games use your race’s starter list meanwhile.</p>
        <Link className="btn" to="/play">Go to Play</Link>
      </div></div>
    );
  }

  return (
    <div className="page decks">
      <div className="coll-head">
        <div>
          <h1>Decks</h1>
          <p className="muted section-lead" style={{ margin: 0 }}>30 cards from one race plus neutrals. Register a deck to play it in Ranked and the Human queue.</p>
        </div>
        <div className="new-deck">
          {RACES.map((r) => (
            <Link key={r} className="btn" to={`/decks/new?race=${r}&starter=1`} style={{ ['--rc' as string]: RACE_COLOR[r] }}>
              <img src={spriteSvg(RACE_INFO[r].sprite)} alt="" className="btn-sprite" />New {RACE_INFO[r].name}
            </Link>
          ))}
          <Link className="btn btn-ghost" to="/decks/new?import=1">Import code</Link>
        </div>
      </div>
      {error && <div className="alert err">Couldn’t read your decks: {error.message.split('\n')[0]}</div>}
      {isLoading ? <p className="muted">Loading decks…</p> : decks.length === 0 ? (
        <div className="panel empty">
          <h2>No decks yet</h2>
          <p>Start from a race’s starter list: claim the free starter deck in Collection first, then register it here in one click.</p>
          <Link className="btn" to="/collection">Claim starter decks</Link>
        </div>
      ) : (
        <div className="deck-grid">
          {decks.map((d) => <DeckTile key={d.id} d={d} fresh={fresh?.toLowerCase() === d.id.toLowerCase()} />)}
        </div>
      )}
    </div>
  );
}

function DeckTile({ d, fresh }: { d: MyDeck; fresh: boolean }) {
  const navigate = useNavigate();
  const [name, setName] = useState(() => deckName(d.id, d.race));
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState<'id' | 'code' | null>(null);
  const copy = async (what: 'id' | 'code', text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(null), 1200); } catch { /* clipboard blocked */ }
  };
  const top = [...new Set(d.cardIds)].map(card).sort((a, b) => b.cost - a.cost).slice(0, 4);
  const status = !d.owned ? { cls: 'banned', text: 'Cards missing' } : d.rankedLegal ? { cls: 'human', text: 'Ranked-legal' } : { cls: '', text: 'Casual only' };
  const save = () => { setDeckName(d.id, name); setEditing(false); setName(deckName(d.id, d.race)); };

  return (
    <article className={`panel deck-tile ${fresh ? 'fresh' : ''}`} style={{ ['--rc' as string]: RACE_COLOR[d.race] }}>
      <div className="dt-head">
        <img src={spriteSvg(RACE_INFO[d.race].sprite)} alt="" />
        <div className="dt-title">
          {editing ? (
            <form onSubmit={(e) => { e.preventDefault(); save(); }}>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={save} maxLength={40} aria-label="Deck name" />
            </form>
          ) : (
            <button className="dt-name" onClick={() => setEditing(true)} title="Rename (stored in this browser)">{name} <span aria-hidden>✎</span></button>
          )}
          <small>{RACE_INFO[d.race].name} · {d.cardIds.length} cards · {d.rarityPoints} pts{d.legendaries ? ` · ${d.legendaries} Legendary` : ''}</small>
        </div>
        <span className={`badge ${status.cls}`}>{status.text}</span>
      </div>
      {fresh && <p className="ok small">✓ Registered on-chain</p>}
      <div className="dt-top">{top.map((c) => <img key={c.id} src={spriteSvg(c.id)} alt={c.name} title={c.name} />)}</div>
      <ManaCurve costs={d.cardIds.map((id) => card(id).cost)} />
      <div className="dt-actions">
        <button className="btn btn-primary" disabled={!d.owned} onClick={() => navigate(`/play?deck=${d.id}`)}>Play</button>
        <Link className="btn" to={`/decks/new?from=${d.id}`}>Edit as new</Link>
        <button className="btn btn-ghost" onClick={() => copy('code', encodeDeck(d.race, d.cardIds))} title="A short code anyone can open in the deck builder">
          {copied === 'code' ? 'Copied ✓' : 'Share code'}
        </button>
        <button className="btn btn-ghost" onClick={() => copy('id', d.id)} title="The on-chain deck id, for the API and agents">
          {copied === 'id' ? 'Copied ✓' : `ID ${shortAddr(d.id)}`}
        </button>
      </div>
    </article>
  );
}
