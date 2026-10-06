import { NavLink, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './auth/AuthProvider.tsx';
import { Logo } from './components/Logo.tsx';
import { WalletButton } from './components/WalletButton.tsx';
import { ComingSoon, Home } from './pages/Home.tsx';
import { Landing } from './pages/Landing.tsx';
import { Economy } from './pages/Economy.tsx';
import { Metrics } from './pages/Metrics.tsx';
import { Learn } from './pages/Learn.tsx';
import { Challenge } from './pages/Challenge.tsx';
import { ChallengeAlert } from './components/Challenges.tsx';
import { Collection } from './pages/Collection.tsx';
import { DeckBuilder } from './pages/DeckBuilder.tsx';
import { Decks } from './pages/Decks.tsx';
import { Match } from './pages/Match.tsx';
import { Matches } from './pages/Matches.tsx';
import { Pass } from './pages/Pass.tsx';
import { Sealed } from './pages/Sealed.tsx';
import { Play } from './pages/Play.tsx';
import { Profile } from './pages/Profile.tsx';
import { Replay } from './pages/Replay.tsx';
import { SignInGate } from './pages/SignInGate.tsx';

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
      <main>{body()}</main>
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
