import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/700.css';
import '@fontsource-variable/inter';
import '../styles/app.css';
import '../styles/game.css';
import '../styles/collection.css';
import { CARDS } from '@forkfall/engine';
import { createRoot } from 'react-dom/client';
import { PackReveal } from '../components/PackReveal.tsx';

/** The pack reveal on five cards, a Legendary and a Rare among them (dev server only, see reveal.html): e2e/reveal.spec.ts checks every rarity label is readable and the effects stay on screen. */
const pick = (rarity: string, n: number) => CARDS.filter((c) => c.rarity === rarity).slice(0, n).map((c) => c.id);
const ids = [...pick('common', 2), ...pick('uncommon', 1), ...pick('rare', 1), ...pick('legendary', 1)];
createRoot(document.getElementById('root')!).render(<PackReveal ids={ids} fresh={ids.map(() => false)} onClose={() => {}} />);
