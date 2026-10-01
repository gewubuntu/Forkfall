import type { LeaderboardRow, MatchSummary } from '@forkfall/sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { Address, Hex } from 'viem';
import { useAuth } from '../auth/AuthProvider.tsx';
import { friendlyError } from '../chain/errors.ts';
import { useHub } from '../chain/useHub.ts';
import { useSeasonStats, useSettled, useSettleMatch } from '../chain/useSettlement.ts';
import { RACE_INFO, raceName } from '../game/meta.ts';
import { avatarSvg, spriteSvg } from '../lib/art.ts';
import { inTime, shortAddr } from '../lib/format.ts';

type Tab = 'history' | 'leaderboard';
type Filter = 'all' | 'rated' | 'casual' | 'practice' | 'action';

const REASON: Record<string, string> = { treasury: 'Treasury drained', concede: 'Conceded', turnLimit: 'Turn limit', timeout: 'Timeout' };
const MODE_LABEL: Record<string, string> = { casual: 'Casual', ranked: 'Ranked', human: 'Human queue' };

export function Matches() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'leaderboard' ? 'leaderboard' : 'history';
  const { config } = useAuth();
  const season = config?.season ?? 1;

  return (
    <div className="page matches">
      <div className="coll-head">
        <div>
          <h1>Matches</h1>
          <p className="muted section-lead" style={{ margin: 0 }}>Your games, their signed logs, and the season ladder. Results count once they settle on-chain.</p>
        </div>
        <MyStats season={season} />
      </div>
      <div className="tabs" role="tablist">
        {(['history', 'leaderboard'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setParams(t === 'history' ? {} : { tab: t })}>
            {t === 'history' ? 'History' : `Leaderboard · Season ${season}`}
          </button>
        ))}
      </div>
      {tab === 'history' ? <History /> : <Leaderboard season={season} />}
    </div>
  );
}

function MyStats({ season }: { season: number }) {
  const { me } = useAuth();
  const { contracts } = useHub();
  const addr = me?.address ? [me.address as Address] : [];
  const ranked = useSeasonStats(addr, season);
  const casual = useSeasonStats(addr, 0);
  if (!contracts || !me) return null;
  const r = ranked.stats.get(me.address.toLowerCase());
  const c = casual.stats.get(me.address.toLowerCase());
  const rec = (s?: { wins: number; losses: number; draws: number }) => (s ? `${s.wins}–${s.losses}${s.draws ? `–${s.draws}` : ''}` : '…');
  return (
    <div className="stat-row" aria-label="Your settled record">
      <div className="stat"><span>Rating</span><b>{r ? r.rating : '…'}</b></div>
      <div className="stat"><span>Ranked W–L</span><b>{rec(r)}</b></div>
      <div className="stat"><span>Casual W–L</span><b>{rec(c)}</b></div>
    </div>
  );
}

// ─── History ──────────────────────────────────────────────────────────────────
function History() {
  const { client, me } = useAuth();
  const { contracts } = useHub();
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const settle = useSettleMatch();

  const q = useQuery({
    queryKey: ['history', me?.address],
    queryFn: async () => (await client!.matches({ player: me!.address as Address })).matches,
    enabled: !!client && !!me,
    refetchInterval: 5000,
  });
  const all = q.data ?? [];
  const ended = all.filter((m) => m.phase === 'ended').map((m) => m.matchId);
  const { settled } = useSettled(ended);

  const seatOf = (m: MatchSummary) => (m.players[0].address.toLowerCase() === me?.address.toLowerCase() ? 0 : 1);
  const needsAction = (m: MatchSummary) => {
    if (m.phase === 'active' || m.phase === 'reveal') return true;
    if (m.phase !== 'ended' || settled.get(m.matchId)) return false;
    return !m.resultSigned[seatOf(m)] || (!!contracts && m.settlement === 'ready');
  };
  const shown = all.filter((m) =>
    filter === 'all' ? true
    : filter === 'rated' ? m.mode !== 'casual'
    : filter === 'casual' ? m.mode === 'casual' && !m.practice
    : filter === 'practice' ? m.practice
    : needsAction(m));
  const actionCount = all.filter(needsAction).length;

  const act = async (m: MatchSummary, kind: 'sign' | 'settle') => {
    setError(null); setBusy(m.matchId);
    try {
      if (kind === 'sign') await client!.signResult(m.matchId);
      else await settle(m.matchId);
      await qc.invalidateQueries({ queryKey: ['history'] });
    } catch (e) { setError(friendlyError(e)); } finally { setBusy(null); }
  };

  return (
    <div className="panel history">
      <div className="filters">
        <div className="chips" role="group" aria-label="Filter matches">
          {([['all', 'All'], ['rated', 'Ranked'], ['casual', 'Casual'], ['practice', 'Practice'], ['action', `Needs you${actionCount ? ` · ${actionCount}` : ''}`]] as const).map(([id, label]) => (
            <button key={id} className={`chip-btn ${filter === id ? 'on' : ''}`} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
        <span className="muted small">{all.length} match{all.length === 1 ? '' : 'es'} on this server</span>
      </div>
      {error && <div className="alert err" role="alert"><span>{error}</span><button onClick={() => setError(null)} aria-label="Dismiss">✕</button></div>}
      {q.isLoading ? <div className="empty"><span className="spinner" aria-label="Loading matches" /></div>
        : shown.length === 0 ? (
          <div className="empty">
            <h2>{all.length ? 'Nothing here' : 'No matches yet'}</h2>
            <p className="muted">{all.length ? 'No match fits this filter.' : 'Play a practice game or join a queue, and your matches show up here with their signed logs.'}</p>
            {!all.length && <Link className="btn btn-primary" to="/play">Go to Play</Link>}
          </div>
        ) : (
          <ol className="match-list">
            {shown.map((m) => (
              <MatchRow key={m.matchId} m={m} seat={seatOf(m)} settled={settled.get(m.matchId)} onchain={!!contracts}
                busy={busy === m.matchId} onSign={() => act(m, 'sign')} onSettle={() => act(m, 'settle')} />
            ))}
          </ol>
        )}
    </div>
  );
}

function MatchRow({ m, seat, settled, onchain, busy, onSign, onSettle }: {
  m: MatchSummary; seat: 0 | 1; settled?: boolean; onchain: boolean; busy: boolean; onSign: () => void; onSettle: () => void;
}) {
  const mine = m.players[seat];
  const opp = m.players[1 - seat];
  const live = m.phase === 'active' || m.phase === 'reveal';
  const outcome = live ? { cls: 'live', text: 'Live' }
    : !m.winner || /^0x0+$/.test(m.winner) ? { cls: 'draw', text: 'Draw' }
    : m.winner.toLowerCase() === mine.address.toLowerCase() ? { cls: 'win', text: 'Victory' } : { cls: 'loss', text: 'Defeat' };
  const signed = m.resultSigned[seat];

  const ref = m.referee;
  const iWon = outcome.cls === 'win';
  let status: React.ReactNode;
  if (live) status = <Link className="btn btn-primary" to={`/match/${m.matchId}`}>Resume</Link>;
  else if (settled) status = <span className="st ok">✓ Settled on-chain{ref?.state === 'settled' ? ' by referee' : ''}</span>;
  else if (ref?.state === 'submitting') status = <span className="st muted"><span className="spinner" /> Referee settling…</span>;
  else if (ref?.state === 'failed') {
    status = <span className="st warn" title={ref.error}>Referee couldn’t settle{ref.willRetry ? ' · retrying' : ''}</span>;
  } else if (!signed) status = <button className="btn btn-primary" onClick={onSign} disabled={busy}>{busy ? <span className="spinner" /> : 'Sign result'}</button>;
  else if (!onchain) status = <span className="st muted">Signed · off-chain server</span>;
  else if (m.settlement === 'ready') status = <button className="btn btn-primary" onClick={onSettle} disabled={busy}>{busy ? <span className="spinner" /> : 'Settle on-chain'}</button>;
  else if (m.settlement === 'referee') {
    status = <span className="st muted" title="Your opponent didn't sign; the referee submits the result with your signature">{m.refereeAt != null ? 'Referee settles shortly' : 'Referee settles'}</span>;
  } else if (iWon && m.refereeAt != null) {
    status = <span className="st muted" title="If your opponent never signs, the referee settles the result with your signature">Opponent hasn’t signed · auto-settles {inTime(m.refereeAt)}</span>;
  } else status = <span className="st muted">Waiting for opponent</span>;

  return (
    <li className={`match-row ${outcome.cls}`}>
      <span className={`outcome ${outcome.cls}`}>{outcome.text}</span>
      <div className="mr-vs">
        <RaceSprite race={mine.race} />
        <span className="muted small">vs</span>
        <img className="avatar" src={avatarSvg(opp.address)} alt="" />
        <div className="mr-opp">
          <div>
            <span style={{ color: `var(--${opp.race})` }}>{raceName(opp.race)}</span>
            {m.practice ? <span className="badge agent">House bot</span> : opp.agent ? <span className="badge agent">Agent</span> : null}
          </div>
          <span className="mono muted small">{shortAddr(opp.address)}</span>
        </div>
      </div>
      <div className="mr-meta">
        <span className={`badge mode-${m.mode}`}>{m.practice ? 'Practice' : MODE_LABEL[m.mode]}</span>
        <span className="muted small">
          {live ? `Turn ${m.turn}` : `${REASON[m.endReason ?? ''] ?? 'Ended'} · turn ${m.turn}`} · {ago(m.endedAt ?? m.createdAt)}
        </span>
      </div>
      <div className="mr-status">{status}</div>
      <div className="mr-links">
        {!live && <Link className="btn btn-ghost" to={`/matches/${m.matchId}`}>Replay</Link>}
      </div>
    </li>
  );
}

function RaceSprite({ race }: { race: MatchSummary['players'][number]['race'] }) {
  return <img className="mr-sprite" src={spriteSvg(RACE_INFO[race].sprite)} alt={`You: ${raceName(race)}`} title={`You played ${raceName(race)}`} />;
}

function ago(ts: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────
function Leaderboard({ season }: { season: number }) {
  const { client, me } = useAuth();
  const { contracts } = useHub();
  const [who, setWho] = useState<'all' | 'humans' | 'agents'>('all');
  const q = useQuery({
    queryKey: ['leaderboard', season],
    queryFn: async () => (await client!.leaderboard(season)).rows,
    enabled: !!client,
    refetchInterval: 15000,
  });
  const rows: LeaderboardRow[] = q.data ?? [];
  const { stats } = useSeasonStats(rows.map((r) => r.address), season);

  const ranked = rows
    .map((r) => ({ ...r, chain: stats.get(r.address.toLowerCase()) }))
    .filter((r) => who === 'all' || (who === 'agents') === r.agent)
    .sort((a, b) => (b.chain?.rating ?? 0) - (a.chain?.rating ?? 0) || b.wins - a.wins || a.losses - b.losses);

  return (
    <div className="panel history">
      <div className="filters">
        <div className="chips" role="group" aria-label="Show players">
          {([['all', 'Everyone'], ['humans', 'Humans'], ['agents', 'Agents']] as const).map(([id, label]) => (
            <button key={id} className={`chip-btn ${who === id ? 'on' : ''}`} aria-pressed={who === id} onClick={() => setWho(id)}>{label}</button>
          ))}
        </div>
        <span className="muted small">{contracts ? 'Rating and record come from MatchSettlement. Elo, K = 32, start 1200.' : 'Off-chain server: records only, no ratings.'}</span>
      </div>
      {q.isLoading ? <div className="empty"><span className="spinner" aria-label="Loading leaderboard" /></div>
        : ranked.length === 0 ? (
          <div className="empty">
            <h2>No ranked games yet this season</h2>
            <p className="muted">Ranked and Human-queue results show up here. Build a ranked-legal deck and queue up.</p>
            <Link className="btn btn-primary" to="/play">Go to Play</Link>
          </div>
        ) : (
          <table className="ladder">
            <thead>
              <tr>
                <th scope="col">#</th><th scope="col">Player</th>
                {contracts && <th scope="col" className="num">Rating</th>}
                <th scope="col" className="num">{contracts ? 'Settled W–L–D' : 'W–L–D'}</th>
                <th scope="col" className="num">Win rate</th>
                {contracts && <th scope="col" className="num" title="Games refereed by this server, settled or not">Played</th>}
              </tr>
            </thead>
            <tbody>
              {ranked.map((r, i) => {
                const rec = contracts ? r.chain : r;
                const games = rec ? rec.wins + rec.losses + rec.draws : 0;
                const isMe = r.address.toLowerCase() === me?.address.toLowerCase();
                return (
                  <tr key={r.address} className={isMe ? 'me' : ''}>
                    <td className="num rank">{i + 1}</td>
                    <td>
                      <div className="lb-player">
                        <img className="avatar" src={avatarSvg(r.address)} alt="" />
                        <span className="mono">{shortAddr(r.address)}</span>
                        {isMe && <span className="badge you">You</span>}
                        {r.agent && <span className="badge agent">Agent</span>}
                      </div>
                    </td>
                    {contracts && <td className="num rating">{r.chain?.rating ?? '…'}</td>}
                    <td className="num">{rec ? `${rec.wins}–${rec.losses}–${rec.draws}` : '…'}</td>
                    <td className="num">{games ? `${Math.round((rec!.wins / games) * 100)}%` : '—'}</td>
                    {contracts && <td className="num muted">{r.wins + r.losses + r.draws}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
    </div>
  );
}
