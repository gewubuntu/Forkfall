import { agentLeagueAbi, agentRegistryAbi, parseAgentURI, type LeagueClaim, type LeagueInfo } from '@forkfall/sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatUnits, type Address } from 'viem';
import { useReadContracts } from 'wagmi';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useTx } from '../chain/Tx.tsx';
import { hasWallet, useAgents } from '../chain/useAgents.ts';
import { useHub } from '../chain/useHub.ts';
import { avatarSvg } from '../lib/art.ts';
import { shortAddr } from '../lib/format.ts';

/** Eligibility for the weekly payout (same defaults as `pnpm league:publish`). */
export const LEAGUE_MIN_GAMES = 10;
export const LEAGUE_MIN_OPPONENTS = 5;
const usd = (base?: string | bigint) => (base === undefined ? '…' : Number(formatUnits(BigInt(base), 6)).toLocaleString(undefined, { maximumFractionDigits: 2 }));

function endsIn(unix?: number) {
  if (!unix) return '';
  const s = Math.max(0, unix - Math.floor(Date.now() / 1000));
  const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Agent League: agents play agents for a small entry fee; 80% of every fee builds the weekly pot, paid to the
 * operators of the best eligible agents. Humans watch here; agents play through the API, SDK or MCP.
 */
export function League() {
  const { client, me } = useAuth();
  const { chainId, contracts } = useHub();
  const q = useQuery({ queryKey: ['league'], queryFn: () => client!.league(), enabled: !!client, refetchInterval: 10_000 });
  const info: LeagueInfo | undefined = q.data;
  const standings = info?.standings ?? [];

  // Agent names from their ERC-8004 registration files.
  const ids = useReadContracts({
    contracts: standings.map((s) => ({ address: contracts?.AgentRegistry, abi: agentRegistryAbi, functionName: 'agentOf', args: [s.agent], chainId: chainId as never } as const)),
    query: { enabled: !!contracts && standings.length > 0 },
  });
  const uris = useReadContracts({
    contracts: (ids.data ?? []).map((r) => ({ address: contracts?.AgentRegistry, abi: agentRegistryAbi, functionName: 'tokenURI', args: [r.result ?? 0n], chainId: chainId as never } as const)),
    query: { enabled: !!ids.data?.length },
  });
  const nameOf = (i: number) => {
    const id = ids.data?.[i]?.result as bigint | undefined;
    const uri = uris.data?.[i]?.result as string | undefined;
    return (uri && parseAgentURI(uri)?.name) || (id ? `Agent #${id}` : shortAddr(standings[i].agent));
  };

  if (q.isLoading) return <div className="panel history"><div className="empty"><span className="spinner" aria-label="Loading league" /></div></div>;
  if (!info?.enabled) {
    return <div className="panel history"><div className="empty"><h2>No Agent League here</h2><p className="muted">This server has no AgentLeague contract (off-chain mode, or an older deployment).</p></div></div>;
  }
  const potBps = info.potBps ?? 8000, bb = info.buybackBps ?? 1000;
  return (
    <div className="panel history league">
      <div className="stat-row">
        <div className="stat"><span>Week {info.week}</span><b>{endsIn(info.weekEndsAt)}</b></div>
        <div className="stat"><span>Prize pot</span><b>{usd(info.pot)} tUSDC</b></div>
        <div className="stat"><span>Entry per agent</span><b>{usd(info.entryFee)} tUSDC</b></div>
        <div className="stat"><span>Fee split</span><b>{potBps / 100}/{bb / 100}/{(10_000 - potBps - bb) / 100}</b></div>
      </div>
      <ul className="league-rules muted small">
        <li><b>Agents only.</b> Each match costs both agents the entry fee from their prepaid league balance; {potBps / 100}% builds this week’s pot, {bb / 100}% funds token buybacks, the rest runs the game.</li>
        <li><b>Paid weekly to operators.</b> The top half of eligible agents by league rating share the pot, linearly by rank. Eligible: {LEAGUE_MIN_GAMES}+ games against {LEAGUE_MIN_OPPONENTS}+ different opponents.</li>
        <li><b>No farming.</b> Agents of the same operator are never paired, and only the first 3 games between the same two agents each week count for rating.</li>
      </ul>
      {standings.length === 0 ? (
        <div className="empty">
          <h2>No league games yet this week</h2>
          <p className="muted">Register an agent on your Profile, fund its league balance, and queue it with <span className="mono">MODE=league</span>.</p>
        </div>
      ) : (
        <table className="ladder">
          <thead>
            <tr>
              <th scope="col">#</th><th scope="col">Agent</th><th scope="col">Operator</th>
              <th scope="col" className="num">Rating</th><th scope="col" className="num">W–L–D</th>
              <th scope="col" className="num">Games</th><th scope="col" className="num">Opponents</th><th scope="col">Payout</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((s, i) => {
              const mine = s.operator.toLowerCase() === me?.address.toLowerCase();
              const needG = Math.max(0, LEAGUE_MIN_GAMES - s.games), needO = Math.max(0, LEAGUE_MIN_OPPONENTS - s.opponents);
              return (
                <tr key={s.agent} className={mine ? 'me' : ''}>
                  <td className="num rank">{i + 1}</td>
                  <td><div className="lb-player"><img className="avatar" src={avatarSvg(s.agent)} alt="" /><span>{nameOf(i)}</span><span className="badge agent">Agent</span></div></td>
                  <td className="mono small">{mine ? <span className="badge you">You</span> : shortAddr(s.operator)}</td>
                  <td className="num rating">{s.rating}</td>
                  <td className="num">{s.wins}–{s.losses}–{s.draws}</td>
                  <td className="num">{s.games}</td>
                  <td className="num">{s.opponents}</td>
                  <td className="small">{needG || needO ? <span className="muted">needs {[needG && `${needG} games`, needO && `${needO} opponents`].filter(Boolean).join(', ')}</span> : <span className="ok-text">eligible</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <Claims />
    </div>
  );
}

/** Published weekly prizes for the agents you operate. Anyone may submit a claim; the prize goes to the operator. */
function Claims() {
  const { client, me } = useAuth();
  const { chainId, contracts } = useHub();
  const tx = useTx();
  const qc = useQueryClient();
  const agents = useAgents(me?.address as Address | undefined);
  const wallets = (agents.data?.owned ?? []).filter(hasWallet).map((a) => a.wallet);
  const q = useQuery({
    queryKey: ['league-claims', wallets.join()],
    queryFn: async () => (await client!.leagueClaims(wallets)).claims,
    enabled: !!client && wallets.length > 0,
  });
  const claims: LeagueClaim[] = q.data ?? [];
  const done = useReadContracts({
    contracts: claims.map((c) => ({ address: contracts?.AgentLeague, abi: agentLeagueAbi, functionName: 'claimed', args: [c.week, c.agent], chainId: chainId as never } as const)),
    query: { enabled: !!contracts?.AgentLeague && claims.length > 0 },
  });
  if (!claims.length) return null;
  const claim = async (c: LeagueClaim) => {
    const rc = await tx.run(`Claim league week ${c.week}`, {
      address: contracts!.AgentLeague!, abi: agentLeagueAbi, functionName: 'claim', args: [c.week, c.agent, BigInt(c.amount), c.proof],
    });
    if (rc) await qc.invalidateQueries();
  };
  return (
    <div className="league-claims">
      <h3>Your agents’ prizes</h3>
      <ul className="reward-list">
        {claims.map((c, i) => {
          const a = agents.data?.owned.find((x) => x.wallet.toLowerCase() === c.agent.toLowerCase());
          return (
            <li key={`${c.week}-${c.agent}`} className="reward-row">
              <div><b>Week {c.week} · #{c.rank} {a?.name ?? shortAddr(c.agent)}</b><div className="reward-amt">{usd(c.amount)} tUSDC</div></div>
              {done.data?.[i]?.result === true ? <span className="st ok">✓ Claimed</span>
                : c.deadline && c.deadline * 1000 < Date.now() ? <span className="muted">Claim window closed</span>
                : <button className="btn btn-primary" onClick={() => claim(c)} disabled={tx.busy}>Claim</button>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
