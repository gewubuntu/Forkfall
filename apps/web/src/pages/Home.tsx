import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider.tsx';
import { LearnBanner } from '../components/LearnBanner.tsx';
import { QuestPanel } from '../components/QuestPanel.tsx';
import { IncomingChallenges } from '../components/Challenges.tsx';
import { avatarSvg, spriteSvg } from '../lib/art.ts';
import { shortAddr, timeLeft } from '../lib/format.ts';
import { CHAIN_NAMES } from '../wagmi.ts';

const NEXT: { to: string; title: string; sprite: number; text: string; ready?: boolean }[] = [
  { to: '/play', title: 'Play', sprite: 8, text: 'Practice against the house bot or queue for casual, ranked and the Human queue.', ready: true },
  { to: '/collection', title: 'Collection', sprite: 24, text: 'Mint your soulbound starter decks, buy and open packs, and craft with Scrap.', ready: true },
  { to: '/decks', title: 'Decks', sprite: 16, text: 'Build 30-card decks, check the ranked rarity budget, and register them on-chain.', ready: true },
  { to: '/matches', title: 'Matches', sprite: 32, text: 'Your history, step-by-step replays verified in the browser, one-click settlement and the season ladder.', ready: true },
  { to: '/profile', title: 'Profile', sprite: 4, text: 'Verify as human to earn, register and link your agents (ERC-8004), claim season rewards.', ready: true },
];

export function Home() {
  const { me, expiresAt, config } = useAuth();
  if (!me) return null;
  return (
    <div className="page">
      <LearnBanner />
      <div className="panel profile" style={{ marginBottom: 24 }}>
        <img className="avatar" src={avatarSvg(me.address)} alt="" />
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1>Welcome back</h1>
          <div className="addr-line" title={me.address}>{shortAddr(me.address)}</div>
          <div className="badges">
            {me.verifiedHuman && <span className="badge human">Verified human</span>}
            {me.agent && <span className="badge agent">Agent</span>}
            {me.bannedFromRanked && <span className="badge banned">Banned from ranked</span>}
            {!me.verifiedHuman && !me.agent && <span className="badge">Player</span>}
          </div>
        </div>
        <dl className="kv">
          <dt>Network</dt><dd>{CHAIN_NAMES[config!.chainId] ?? config!.chainId}</dd>
          <dt>Session</dt><dd>ends in {expiresAt ? timeLeft(expiresAt - Date.now()) : '–'}</dd>
          <dt>On-chain checks</dt><dd>{me.onchain ? 'on' : 'off (server has no RPC)'}</dd>
        </dl>
      </div>
      <IncomingChallenges />
      <QuestPanel />
      <div className="grid4">
        {NEXT.map((f) => (
          <Link className="panel feature" to={f.to} key={f.to}>
            {f.ready ? <span className="badge soon live">Live</span> : <span className="badge soon">Coming next</span>}
            <img className="ico" src={spriteSvg(f.sprite)} alt="" />
            <h3>{f.title}</h3>
            <p>{f.text}</p>
          </Link>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 20 }}>
        Play, Collection, Decks and Matches are live on testnet. Agents use the same referee API, so their games show up in the same history and ladder.
        {' '}<Link to="/economy">How the economy will work →</Link>
      </p>
    </div>
  );
}

export function ComingSoon({ title }: { title: string }) {
  return (
    <div className="page">
      <div className="panel empty">
        <h2>{title}</h2>
        <p>This screen is coming in a later feature.</p>
        <Link className="btn" to="/">Back home</Link>
      </div>
    </div>
  );
}
