import { lazy, Suspense, useLayoutEffect, type ComponentType } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './auth/AuthProvider.tsx';
import { Logo } from './components/Logo.tsx';
import { WalletButton } from './components/WalletButton.tsx';
import { ComingSoon, Home } from './pages/Home.tsx';
import { Landing } from './pages/Landing.tsx';
import { ChallengeAlert } from './components/Challenges.tsx';
import { SignInGate } from './pages/SignInGate.tsx';

// Every other page loads on first visit (its own chunk), so the landing page and sign-in stay light on a phone.
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));
const Economy = page(() => import('./pages/Economy.tsx'), 'Economy');
const Metrics = page(() => import('./pages/Metrics.tsx'), 'Metrics');
const Learn = page(() => import('./pages/Learn.tsx'), 'Learn');
const Challenge = page(() => import('./pages/Challenge.tsx'), 'Challenge');
const Collection = page(() => import('./pages/Collection.tsx'), 'Collection');
const DeckBuilder = page(() => import('./pages/DeckBuilder.tsx'), 'DeckBuilder');
const Decks = page(() => import('./pages/Decks.tsx'), 'Decks');
const Match = page(() => import('./pages/Match.tsx'), 'Match');
const Matches = page(() => import('./pages/Matches.tsx'), 'Matches');
const Pass = page(() => import('./pages/Pass.tsx'), 'Pass');
const Sealed = page(() => import('./pages/Sealed.tsx'), 'Sealed');
const Play = page(() => import('./pages/Play.tsx'), 'Play');
const Profile = page(() => import('./pages/Profile.tsx'), 'Profile');
const Replay = page(() => import('./pages/Replay.tsx'), 'Replay');
const pageLoading = <div className="gate"><span className="spinner" aria-label="Loading" /></div>;

const NAV = [
  { to: '/play', label: 'Play' },
  { to: '/pass', label: 'Pass' },
  { to: '/collection', label: 'Collection' },
  { to: '/decks', label: 'Decks' },
  { to: '/matches', label: 'Matches' },
];

export function App() {
  const auth = useAuth();
  const signedIn = auth.status === 'signedIn';
  const path = useLocation().pathname;
  const inMatch = path.startsWith('/match/') || path.startsWith('/learn/');
  // Phones hide the header and banner on the board and lock pull-to-refresh (game.css, html.in-match). Set before
  // the first paint, or the board jumps up when the header disappears (a layout shift).
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('in-match', inMatch);
    return () => document.documentElement.classList.remove('in-match');
  }, [inMatch]);

  return (
    <>
      <div className="testnet-banner">Testnet alpha: no real value. Never use a wallet that holds real funds.</div>
      <header className="header">
        <Logo />
        {signedIn && (
          <nav className="nav" aria-label="Main">
            {NAV.map((n) => <NavLink key={n.to} to={n.to}>{n.label}</NavLink>)}
          </nav>
        )}
        <div className="spacer" />
        {auth.status !== 'offline' && auth.status !== 'loading' && <WalletButton />}
      </header>
      <main><Suspense fallback={pageLoading}>{body()}</Suspense></main>
      {signedIn && <ChallengeAlert />}
      {signedIn && !inMatch && (
        <nav className="mobile-nav" aria-label="Main">
          <NavLink to="/" end>Home</NavLink>
          {NAV.map((n) => <NavLink key={n.to} to={n.to}>{n.label}</NavLink>)}
        </nav>
      )}
    </>
  );

  function body() {
    // Lessons run entirely in the browser: no wallet, no sign-in, not even the server.
    if ((path === '/learn' || path.startsWith('/learn/')) && auth.status !== 'loading') return <Learn />;
    // The economy page is public: no wallet, no sign-in.
    if (path === '/economy' && auth.status !== 'loading') return <Economy />;
    // The alpha numbers are public aggregates too.
    if (path === '/metrics' && auth.status !== 'loading' && auth.status !== 'offline') return <Metrics />;
    // A challenge link works before sign-in: it shows who challenged you and walks you through connecting.
    if (path.startsWith('/challenge/') && auth.status !== 'loading' && auth.status !== 'offline') {
      return <Routes><Route path="/challenge/:code" element={<Challenge />} /></Routes>;
    }
    switch (auth.status) {
      case 'loading':
        return <div className="gate"><span className="spinner" aria-label="Loading" /></div>;
      case 'offline':
        return (
          <div className="gate"><div className="card">
            <h2>Server offline</h2>
            <p className="lead">The Forkfall referee server is not reachable. Start it with <span className="mono">pnpm server</span> and reload.</p>
            <button className="btn" onClick={() => location.reload()}>Retry</button>
          </div></div>
        );
      case 'disconnected':
        return <Landing />;
      case 'wrongChain':
      case 'needsSignIn':
      case 'signingIn':
        return <SignInGate />;
      case 'signedIn':
        return (
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/play" element={<Play />} />
            <Route path="/match/:id" element={<Match />} />
            <Route path="/collection" element={<Collection />} />
            <Route path="/pass" element={<Pass />} />
            <Route path="/sealed" element={<Sealed />} />
            <Route path="/decks" element={<Decks />} />
            <Route path="/decks/new" element={<DeckBuilder />} />
            <Route path="/matches" element={<Matches />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/matches/:id" element={<Replay />} />
            <Route path="*" element={<ComingSoon title="Not found" />} />
          </Routes>
        );
    }
  }
}
