import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/700.css';
import '@fontsource-variable/inter';
import '../styles/app.css';
import '../styles/game.css';
import '../styles/collection.css';
import '../styles/decks.css';
import '../styles/matches.css';
import { CARDS } from '@forkfall/engine';
import { createRoot } from 'react-dom/client';
import { GameCard } from '../components/GameCard.tsx';

/**
 * Every card at every size it is shown at, one section per size (dev server only, see cards.html). The cards must all be
 * as tall as each other within a section, with no text cut off: e2e/cards.spec.ts checks it.
 *
 * - grid-N: Collection / deck-builder cells and pack-reveal cards (138), N px wide (a phone's grid is ~104–120 px, a desktop's 150).
 * - hand: the match hand (118 px, inside `.hand`).
 * - board, mini: the match board and the replay / sealed hands.
 * - compact-hand, compact-replay-hand: the phone layouts' hands (game.css, matches.css), five cards wide.
 */
export const GRID_WIDTHS = [104, 111, 128, 138, 150];

function Section({ id, children }: { id: string; children: React.ReactNode }) {
  return <section id={id} data-cards style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start', padding: 8 }}>{children}</section>;
}

createRoot(document.getElementById('root')!).render(
  <div>
    {GRID_WIDTHS.map((w) => (
      <Section key={w} id={`grid-${w}`}>
        {CARDS.map((c) => <div key={c.id} className="grid-cell" style={{ width: w }}><GameCard cardId={c.id} size="hand" /></div>)}
      </Section>
    ))}
    <div className="match"><div className="arena">
      <div id="hand" data-cards className="hand" style={{ flexWrap: 'wrap', overflow: 'visible' }}>
        {CARDS.map((c) => <GameCard key={c.id} cardId={c.id} size="hand" />)}
      </div>
    </div></div>
    <div className="match compact"><div className="arena">
      <div id="compact-hand" data-cards className="hand" style={{ ['--n' as string]: 5, flexWrap: 'wrap', height: 'auto', overflow: 'visible' }}>
        {CARDS.map((c) => <GameCard key={c.id} cardId={c.id} size="hand" />)}
      </div>
    </div></div>
    <div className="match replay compact"><div className="arena">
      <div id="compact-replay-hand" data-cards className="hand replay-hand" style={{ ['--n' as string]: 5, flexWrap: 'wrap', height: 'auto', overflow: 'visible' }}>
        {CARDS.map((c) => <GameCard key={c.id} cardId={c.id} size="mini" />)}
      </div>
    </div></div>
    <Section id="board">{CARDS.map((c) => <GameCard key={c.id} cardId={c.id} size="board" />)}</Section>
    <Section id="mini">{CARDS.map((c) => <GameCard key={c.id} cardId={c.id} size="mini" />)}</Section>
  </div>,
);
