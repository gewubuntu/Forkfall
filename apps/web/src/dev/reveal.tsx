import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/700.css';
import '@fontsource-variable/inter';
import '../styles/app.css';
import '../styles/game.css';
import '../styles/collection.css';
import { CARDS } from '@forkfall/engine';
import { createRoot } from 'react-dom/client';
import { PackReveal } from '../components/PackReveal.tsx';

/** The pack reveal on five cards (dev server only, see reveal.html): e2e/reveal.spec.ts checks every rarity label is readable. */
const ids = CARDS.filter((c) => c.text.length > 100 || c.type !== 'unit').slice(0, 5).map((c) => c.id);
createRoot(document.getElementById('root')!).render(<PackReveal ids={ids} fresh={ids.map(() => false)} onClose={() => {}} />);
