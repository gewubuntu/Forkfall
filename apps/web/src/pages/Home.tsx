import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider.tsx';
import { avatarSvg, spriteSvg } from '../lib/art.ts';
import { shortAddr, timeLeft } from '../lib/format.ts';
import { CHAIN_NAMES } from '../wagmi.ts';

const NEXT: { to: string; title: string; sprite: number; text: string; ready?: boolean }[] = [
  { to: '/play', title: 'Play', sprite: 8, text: 'Practice against the house bot or queue for casual, ranked and the Human queue.', ready: true },
  { to: '/collection', title: 'Collection', sprite: 24, text: 'Mint your soulbound starter decks, buy and open packs, and craft with Scrap.', ready: true },
  { to: '/decks', title: 'Decks', sprite: 16, text: 'Build 30-card decks, check the ranked rarity budget, and register them on-chain.' },
  { to: '/matches', title: 'Matches', sprite: 32, text: 'Watch live games, replay signed logs, and settle results on-chain.' },
];

export function Home() {
  const { me, expiresAt, config } = useAuth();
  if (!me) return null;
  return (
    <div className="page">
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
        These screens are being rebuilt one feature at a time. Play, matches and your collection are live; the deck builder and match history come next.
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
