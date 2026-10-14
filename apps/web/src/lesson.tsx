import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/700.css';
import '@fontsource-variable/inter';
import './styles/app.css';
import './styles/game.css';

import { StrictMode, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { Logo } from './components/Logo.tsx';
import { reloadForNewBuild } from './lib/chunkReload.ts';
import { Learn } from './pages/Learn.tsx';

/*
 * Entry for lesson.html: a lesson opened straight from a link. Lessons run entirely in the browser, so this page
 * leaves out the wallet stack (wagmi, viem, sign-in) that main.tsx loads for every other page, and only app.css and
 * game.css. Following a link to anything but another lesson reloads into the full app.
 */

window.addEventListener('vite:preloadError', (e) => { if (reloadForNewBuild()) e.preventDefault(); });

/** Anywhere outside a lesson: load that page from the server, which serves the full app (index.html). */
function FullApp() {
  useLayoutEffect(() => { window.location.reload(); }, []);
  return <div className="gate"><span className="spinner" aria-label="Loading" /></div>;
}

function LessonShell() {
  // As on the match board in the full app: phones hide the header and banner (game.css, html.in-match).
  useLayoutEffect(() => { document.documentElement.classList.add('in-match'); }, []);
  return (
    <>
      <div className="testnet-banner">Testnet alpha: no real value. Never use a wallet that holds real funds.</div>
      <header className="header"><Logo /><div className="spacer" /></header>
      <main>
        <Routes>
          <Route path="/learn/:id" element={<Learn />} />
          <Route path="*" element={<FullApp />} />
        </Routes>
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <LessonShell />
    </BrowserRouter>
  </StrictMode>,
);
