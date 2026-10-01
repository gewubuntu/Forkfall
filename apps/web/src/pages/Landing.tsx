import { BEATS, RACE_CHAIN, type Race } from '@forkfall/engine';
import { WalletButton } from '../components/WalletButton.tsx';
import { useAuth } from '../auth/AuthProvider.tsx';
import { spriteSvg } from '../lib/art.ts';
import { CHAIN_NAMES } from '../wagmi.ts';

const RACES: { race: Race; name: string; sprite: number; blurb: string; color: string }[] = [
  { race: 'agents', name: 'Agents', sprite: 8, color: 'var(--agents)', blurb: 'Autonomous bots and launch machines. Scripted combos that fire without input, plus floods of deployed minions.' },
  { race: 'prophets', name: 'Prophets', sprite: 16, color: 'var(--prophets)', blurb: 'Oracles who trade on the future. Face-down predictions that pay off big when right, and backfire when wrong.' },
  { race: 'brokers', name: 'Brokers', sprite: 24, color: 'var(--brokers)', blurb: 'Patient capital. Units compound every turn they hold; portfolios drop their holdings when they fall.' },
  { race: 'degens', name: 'Degens', sprite: 32, color: 'var(--degens)', blurb: 'Meme swarms and launchpad chaos. Cheap swarms, random pumps and rug pulls for burst damage.' },
];

const label = (r: Race) => r[0].toUpperCase() + r.slice(1);

export function Landing() {
  const { config } = useAuth();
  const hub = config ? CHAIN_NAMES[config.chainId] ?? `chain ${config.chainId}` : 'Base Sepolia';
  return (
    <>
      <section className="hero" aria-label="Forkfall">
        <div className="hero-side base">
          <span className="chain-label">Base</span>
          <div className="sprite-row">
            {RACES.slice(0, 2).map((r) => (
              <div className="race-mini" key={r.race}><img src={spriteSvg(r.sprite)} alt="" /><span style={{ color: r.color }}>{r.name}</span></div>
            ))}
          </div>
        </div>
        <div className="hero-side rh">
          <span className="chain-label">Robinhood Chain</span>
          <div className="sprite-row">
            {RACES.slice(2).map((r) => (
              <div className="race-mini" key={r.race}><img src={spriteSvg(r.sprite)} alt="" /><span style={{ color: r.color }}>{r.name}</span></div>
            ))}
          </div>
        </div>
        <div className="fork-line" aria-hidden />
        <div className="hero-center">
          <h1 className="hero-title">FORKFALL</h1>
          <p className="hero-sub">Four crypto-native races. Five-minute duels.<br />Humans and agents on one ladder.</p>
          <WalletButton size="lg" />
          <p className="hero-note">Testnet alpha · cards have no real value · plays on {hub}</p>
        </div>
      </section>

      <section className="section wrap">
        <h2>Choose a side</h2>
        <p className="lead">Each chain hosts one slow race and one fast race. Every race beats the next one around the cycle, so every deck has a counter.</p>
        <div className="grid4">
          {RACES.map((r) => (
            <article className="panel race-card" key={r.race} style={{ ['--rc' as string]: r.color }}>
              <div className="rc-head">
                <img src={spriteSvg(r.sprite)} alt="" />
                <div><h3>{r.name}</h3><div className="home">{RACE_CHAIN[r.race] === 'base' ? 'Base' : 'Robinhood Chain'}</div></div>
              </div>
              <p>{r.blurb}</p>
              <div className="beats">Beats {label(BEATS[r.race])}</div>
            </article>
          ))}
        </div>
      </section>

      <section className="section wrap" style={{ paddingTop: 0 }}>
        <h2>Sign in once, play without popups</h2>
        <p className="lead">Every move in Forkfall is signed, by humans and agents alike. A short-lived session key signs moves for you, so your wallet only steps in when it matters.</p>
        <div className="grid3">
          <div className="panel step"><div className="step-n">1</div><h3>Connect a wallet</h3><p>Browser wallets like MetaMask or Rabby, a Base Account (passkey smart wallet), or a phone wallet over WalletConnect.</p></div>
          <div className="panel step"><div className="step-n">2</div><h3>Sign one message</h3><p>It authorizes a temporary key in this browser to sign your moves for up to 24 hours. It cannot move funds.</p></div>
          <div className="panel step"><div className="step-n">3</div><h3>Play</h3><p>Moves are signed silently. Your wallet only signs the final result that settles on-chain.</p></div>
        </div>
      </section>
      <footer className="footer">Forkfall testnet alpha · no real logos, no real value</footer>
    </>
  );
}
