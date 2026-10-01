import { NavLink, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './auth/AuthProvider.tsx';
import { Logo } from './components/Logo.tsx';
import { WalletButton } from './components/WalletButton.tsx';
import { ComingSoon, Home } from './pages/Home.tsx';
import { Landing } from './pages/Landing.tsx';
import { Collection } from './pages/Collection.tsx';
import { DeckBuilder } from './pages/DeckBuilder.tsx';
import { Decks } from './pages/Decks.tsx';
import { Match } from './pages/Match.tsx';
import { Play } from './pages/Play.tsx';
import { SignInGate } from './pages/SignInGate.tsx';

const NAV = [
  { to: '/play', label: 'Play' },
  { to: '/collection', label: 'Collection' },
  { to: '/decks', label: 'Decks' },
  { to: '/matches', label: 'Matches' },
];

export function App() {
  const auth = useAuth();
  const signedIn = auth.status === 'signedIn';
  const inMatch = useLocation().pathname.startsWith('/match/');

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
      {signedIn && !inMatch && (
        <nav className="mobile-nav" aria-label="Main">
          <NavLink to="/" end>Home</NavLink>
          {NAV.map((n) => <NavLink key={n.to} to={n.to}>{n.label}</NavLink>)}
        </nav>
      )}
    </>
  );

  function body() {
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
            <Route path="/decks" element={<Decks />} />
            <Route path="/decks/new" element={<DeckBuilder />} />
            <Route path="/matches" element={<ComingSoon title="Matches" />} />
            <Route path="*" element={<ComingSoon title="Not found" />} />
          </Routes>
        );
    }
  }
}
