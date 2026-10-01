import {
  agentRegistryAbi, agentURIFromFile, buildAgentRegistration, seasonRewardsAbi,
  type AgentWalletProof, type HumanStatus, type PlayerReward,
} from '@forkfall/sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatUnits, getAddress, isAddress, isHex, type Address } from 'viem';
import { useReadContracts } from 'wagmi';
import { useAuth } from '../auth/AuthProvider.tsx';
import { friendlyError } from '../chain/errors.ts';
import { useTx } from '../chain/Tx.tsx';
import { hasWallet, useAgents, type AgentInfo } from '../chain/useAgents.ts';
import { useHub } from '../chain/useHub.ts';
import { useMyDecks } from '../chain/useMyDecks.ts';
import { useSeasonStats } from '../chain/useSettlement.ts';
import { avatarSvg } from '../lib/art.ts';
import { shortAddr } from '../lib/format.ts';

const day = (unix: number) => new Date(unix * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export function Profile() {
  const { me, config } = useAuth();
  const { contracts } = useHub();
  const addr = me?.address as Address | undefined;
  const season = config?.season ?? 1;
  const { stats } = useSeasonStats(addr ? [addr] : [], season);
  const { decks } = useMyDecks(addr);
  const agents = useAgents(addr);
  const [copied, setCopied] = useState(false);
  if (!me || !addr) return null;
  const s = stats.get(addr.toLowerCase());

  const copy = async () => { await navigator.clipboard.writeText(addr).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  return (
    <div className="page profile-page">
      <div className="profile-head">
        <img className="avatar" src={avatarSvg(addr)} alt="" />
        <div className="ph-main">
          <h1>Profile</h1>
          <button className="ph-addr mono" onClick={copy} title="Copy address">{addr} <span className="muted">{copied ? '✓ copied' : '⧉'}</span></button>
          <div className="badges">
            {me.agent ? <span className="badge agent">Agent{me.agentId ? ` #${me.agentId}` : ''}</span>
              : me.verifiedHuman ? <span className="badge human">Verified human</span>
              : <span className="badge">Player</span>}
            {me.bannedFromRanked && <span className="badge banned">Banned from ranked</span>}
          </div>
        </div>
        {contracts && (
          <div className="stat-row">
            <div className="stat"><span>Rating · S{season}</span><b>{s ? s.rating : '…'}</b></div>
            <div className="stat"><span>Ranked W–L</span><b>{s ? `${s.wins}–${s.losses}` : '…'}</b></div>
            <div className="stat"><span>Decks</span><b>{decks.length}</b></div>
          </div>
        )}
      </div>

      {!contracts ? (
        <div className="panel empty"><h2>Identity needs the hub contracts</h2><p>This server runs off-chain, so there is no agent registry, verification or rewards here.</p></div>
      ) : (
        <>
          {me.bannedFromRanked && <div className="alert err">A moderator banned this wallet from ranked play and the Human queue. Casual and practice games still work.</div>}
          <div className="profile-grid">
            <HumanCard />
            <ThisWalletCard agents={agents.data} loading={agents.isLoading} />
          </div>
          <AgentsCard data={agents.data} loading={agents.isLoading} error={agents.error} />
          <RewardsCard />
        </>
      )}
    </div>
  );
}

// ─── Human verification (optional: gates rewards, not the Human queue) ────────
function HumanCard() {
  const { client, me, refreshMe } = useAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['human', me?.address], queryFn: () => client!.human(), enabled: !!client });
  const h: HumanStatus | undefined = q.data;

  const verify = async (method: string) => {
    setErr(null); setBusy(method);
    try {
      await client!.verifyHuman(method);
      await Promise.all([qc.invalidateQueries({ queryKey: ['human'] }), refreshMe()]);
    } catch (e) { setErr(friendlyError(e)); } finally { setBusy(null); }
  };

  return (
    <section className="panel id-card">
      <h2>Human verification</h2>
      <p className="muted small">Optional. The Human queue is open to everyone who isn’t a registered agent. Verifying makes you eligible for season rewards.</p>
      {!h ? <span className="spinner" aria-label="Loading" />
        : h.agentId > 0 ? <p className="note">This wallet is registered agent #{h.agentId}, so it can’t verify as human. Agents earn rewards through their registration.</p>
        : (
          <>
            {h.verified ? (
              <div className="id-status ok">
                <b>✓ Verified human</b>
                <span className="muted small">{h.method === 'testnet' ? 'Testnet check' : h.method} · since {day(h.verifiedAt!)}{h.expiresAt ? ` · until ${day(h.expiresAt)}` : ''}</span>
              </div>
            ) : (
              <div className="id-status"><b>Not verified</b><span className="muted small">You can still play every queue; you just don’t earn season rewards yet.</span></div>
            )}
            {err && <div className="alert err">{err}</div>}
            <ul className="methods">
              {h.methods.map((m) => (
                <li key={m.id} className={m.available ? '' : 'soon'}>
                  <div>
                    <b>{m.label}</b>{m.id === 'testnet' && <span className="badge">Testnet</span>}
                    <p className="muted small">{m.description}</p>
                  </div>
                  {m.available ? (
                    <button className="btn btn-primary" onClick={() => verify(m.id)} disabled={!!busy}>
                      {busy === m.id ? <span className="spinner" /> : h.verified ? 'Renew' : 'Verify'}
                    </button>
                  ) : <span className="badge soon">Coming soon</span>}
                </li>
              ))}
            </ul>
          </>
        )}
    </section>
  );
}

// ─── The connected wallet as an agent ─────────────────────────────────────────
function ThisWalletCard({ agents, loading }: { agents?: ReturnType<typeof useAgents>['data']; loading: boolean }) {
  const { me } = useAuth();
  const a = agents?.playsAs;
  return (
    <section className="panel id-card">
      <h2>This wallet</h2>
      {loading || !agents ? <span className="spinner" aria-label="Loading" />
        : a ? (
          <>
            <div className="id-status agent"><b>Plays as agent #{a.id} · {a.name}</b><span className="muted small">Agent badge in every match; stays out of the Human queue.</span></div>
            <dl className="kv small">
              <dt>Owner (operator)</dt><dd className="mono">{a.owner.toLowerCase() === me!.address.toLowerCase() ? 'You' : shortAddr(a.owner)}</dd>
              {a.file?.description && <><dt>Description</dt><dd>{a.file.description}</dd></>}
            </dl>
            <p className="muted small">To stop playing as this agent, its owner unlinks the wallet or removes the agent{a.owner.toLowerCase() === me!.address.toLowerCase() ? ' below' : ''}.</p>
          </>
        ) : (
          <>
            <div className="id-status"><b>Human player</b><span className="muted small">Not linked to any agent. You can play the Human queue.</span></div>
            <p className="muted small">Running a bot? Register it under <b>Agents you operate</b>. Bots must be registered; unregistered bots get banned from ranked.</p>
          </>
        )}
    </section>
  );
}

// ─── Agents this wallet operates (ERC-8004 agent NFTs it owns) ────────────────
function parseProof(text: string, owner: Address): AgentWalletProof | string {
  let p: AgentWalletProof;
  try { p = JSON.parse(text); } catch { return 'Paste the JSON printed by pnpm agent:link.'; }
  if (!p || !isAddress(p.wallet ?? '') || !isAddress(p.owner ?? '') || !isHex(p.signature) || !Number.isInteger(p.agentId) || !Number.isInteger(p.deadline)) {
    return 'That JSON is missing agentId, wallet, owner, deadline or signature.';
  }
  if (getAddress(p.owner) !== getAddress(owner)) return `This proof was signed for owner ${shortAddr(p.owner)}, not you. Re-run with OWNER=${owner}.`;
  if (p.deadline * 1000 < Date.now()) return 'This proof has expired. Run pnpm agent:link again.';
  return p;
}

function AgentsCard({ data, loading, error }: { data?: ReturnType<typeof useAgents>['data']; loading: boolean; error: Error | null }) {
  const { me, config, refreshMe } = useAuth();
  const tx = useTx();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const owner = me!.address as Address;
  const done = async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['agents'] }), refreshMe()]); };

  return (
    <section className="panel agents-card">
      <div className="card-head">
        <div>
          <h2>Agents you operate {data && <span className="muted">· {data.owned.length}/{data.cap}</span>}</h2>
          <p className="muted small">Agents are ERC-8004 identities (an NFT you own). The agent plays from its own linked wallet and carries the Agent badge; you stay a human player.</p>
        </div>
        {data && !open && data.owned.length < data.cap && <button className="btn btn-primary" onClick={() => setOpen(true)}>Register an agent</button>}
      </div>
      {error && <div className="alert err">{friendlyError(error)}</div>}
      {loading || !data ? <span className="spinner" aria-label="Loading agents" /> : (
        <>
          {open && <RegisterAgent nextId={data.nextId} registry={data.registry} chainId={config!.chainId} owner={owner}
            onClose={() => setOpen(false)} onDone={async () => { setOpen(false); await done(); }} run={tx.run} />}
          {data.owned.length === 0 && !open && <p className="muted">You don’t operate any agents.</p>}
          <ul className="agent-list">
            {data.owned.map((a) => <AgentRow key={a.id} a={a} owner={owner} registry={data.registry} onDone={done} run={tx.run} />)}
          </ul>
        </>
      )}
    </section>
  );
}

function LinkCommand({ owner, agentId }: { owner: Address; agentId?: number }) {
  const server = window.location.origin;
  const cmd = `PRIVATE_KEY=<agent key> OWNER=${owner}${agentId ? ` AGENT_ID=${agentId}` : ''}${server.includes('localhost') ? '' : ` SERVER_URL=${server}`} pnpm agent:link`;
  return <pre className="cmd" aria-label="Command to run with the agent's key">{cmd}</pre>;
}

function RegisterAgent({ nextId, registry, chainId, owner, onClose, onDone, run }: {
  nextId: number; registry: Address; chainId: number; owner: Address;
  onClose: () => void; onDone: () => Promise<void>; run: ReturnType<typeof useTx>['run'];
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mcp, setMcp] = useState('');
  const [mode, setMode] = useState<'link' | 'self'>('link');
  const [proofText, setProofText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(null);
    if (!name.trim()) { setErr('Give your agent a name.'); return; }
    let proof: AgentWalletProof | null = null;
    if (mode === 'link') {
      const p = parseProof(proofText.trim(), owner);
      if (typeof p === 'string') { setErr(p); return; }
      proof = p;
    }
    const agentId = proof?.agentId ?? nextId;
    const uri = agentURIFromFile(buildAgentRegistration({ name: name.trim(), description: description.trim(), mcp: mcp.trim() || undefined, agentId, chainId, registry }));
    setBusy(true);
    const rc = proof
      ? await run(`Register ${name.trim()}`, { address: registry, abi: agentRegistryAbi, functionName: 'registerWithWallet', args: [uri, BigInt(proof.agentId), proof.wallet, BigInt(proof.deadline), proof.signature] })
      : await run(`Register ${name.trim()}`, { address: registry, abi: agentRegistryAbi, functionName: 'register', args: [uri] });
    setBusy(false);
    if (rc) await onDone();
  };

  return (
    <div className="register-agent">
      <div className="opts">
        <label className="grow">Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={48} placeholder="Greedy Brokers Bot" /></label>
        <label className="grow">MCP endpoint <span className="muted">(optional)</span><input value={mcp} onChange={(e) => setMcp(e.target.value)} placeholder="https://bot.example/mcp" /></label>
      </div>
      <div className="opts">
        <label className="grow">Description<input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder="What it plays and how" /></label>
      </div>
      <div className="seg two" role="radiogroup" aria-label="Agent wallet">
        <button role="radio" aria-checked={mode === 'link'} className={mode === 'link' ? 'on' : ''} onClick={() => setMode('link')}>Agent has its own wallet</button>
        <button role="radio" aria-checked={mode === 'self'} className={mode === 'self' ? 'on' : ''} onClick={() => setMode('self')}>This wallet is the agent</button>
      </div>
      {mode === 'link' ? (
        <>
          <p className="muted small">Run this with the agent’s key; it signs a proof that the agent’s wallet agrees to be linked (agent id {nextId}). Paste the output below.</p>
          <LinkCommand owner={owner} />
          <textarea className="proof" rows={3} value={proofText} onChange={(e) => setProofText(e.target.value)} placeholder='{"agentId":…,"wallet":"0x…","owner":"0x…","deadline":…,"signature":"0x…"}' aria-label="Agent wallet proof" />
        </>
      ) : (
        <p className="hint warn">Your own wallet becomes the agent: it gets the Agent badge and can no longer join the Human queue or verify as human.</p>
      )}
      {err && <div className="alert err">{err}</div>}
      <div className="row-end">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? <span className="spinner" /> : 'Register agent'}</button>
      </div>
      <p className="muted small">The ERC-8004 registration file (name, description, endpoints) is stored on-chain as the agent’s URI.</p>
    </div>
  );
}

function AgentRow({ a, owner, registry, onDone, run }: { a: AgentInfo; owner: Address; registry: Address; onDone: () => Promise<void>; run: ReturnType<typeof useTx>['run'] }) {
  const [linking, setLinking] = useState(false);
  const [proofText, setProofText] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const linked = hasWallet(a);
  const selfLinked = linked && a.wallet.toLowerCase() === owner.toLowerCase();

  const act = async (label: string, functionName: string, args: unknown[]) => {
    setErr(null);
    const rc = await run(label, { address: registry, abi: agentRegistryAbi, functionName, args });
    if (rc) { setLinking(false); setConfirmRemove(false); await onDone(); }
  };
  const link = () => {
    const p = parseProof(proofText.trim(), owner);
    if (typeof p === 'string') { setErr(p); return; }
    if (p.agentId !== a.id) { setErr(`This proof is for agent #${p.agentId}; run it with AGENT_ID=${a.id}.`); return; }
    act(`Link wallet to ${a.name}`, 'setAgentWallet', [BigInt(a.id), p.wallet, BigInt(p.deadline), p.signature]);
  };

  return (
    <li className="agent-row">
      <div className="ar-main">
        <div className="ar-title"><b>{a.name}</b><span className="badge agent">#{a.id}</span>{a.file?.services.some((x) => x.name === 'MCP') && <span className="badge">MCP</span>}</div>
        {a.file?.description && <p className="muted small">{a.file.description}</p>}
        <div className="small">
          Plays from: {linked ? <span className="mono">{selfLinked ? 'your wallet' : shortAddr(a.wallet)}</span> : <span className="warn-text">no wallet linked: can’t play as this agent</span>}
        </div>
      </div>
      <div className="ar-actions">
        {!linking && <button className="btn btn-ghost" onClick={() => setLinking(true)}>{linked ? 'Change wallet' : 'Link wallet'}</button>}
        {linked && <button className="btn btn-ghost" onClick={() => act(`Unlink ${a.name}`, 'unsetAgentWallet', [BigInt(a.id)])}>Unlink</button>}
        {!confirmRemove
          ? <button className="btn btn-ghost danger" onClick={() => setConfirmRemove(true)}>Remove</button>
          : <button className="btn btn-danger-solid" onClick={() => act(`Remove ${a.name}`, 'burn', [BigInt(a.id)])}>Confirm remove</button>}
      </div>
      {linking && (
        <div className="ar-link">
          <p className="muted small">Run this with the agent’s key and paste the output:</p>
          <LinkCommand owner={owner} agentId={a.id} />
          <textarea className="proof" rows={3} value={proofText} onChange={(e) => setProofText(e.target.value)} aria-label="Agent wallet proof" />
          <div className="row-end"><button className="btn" onClick={() => setLinking(false)}>Cancel</button><button className="btn btn-primary" onClick={link}>Link wallet</button></div>
        </div>
      )}
      {err && <div className="alert err">{err}</div>}
    </li>
  );
}

// ─── Season rewards ───────────────────────────────────────────────────────────
const EXCLUDED: Record<NonNullable<PlayerReward['excluded']>, string> = {
  unverified: 'You played ranked but weren’t verified as human (or registered as an agent), so you didn’t earn. Verify above to earn next season.',
  banned: 'This wallet was banned from ranked during the season.',
  'no-wins': 'No settled ranked wins this season.',
};

function RewardsCard() {
  const { client, me, config } = useAuth();
  const { chainId, contracts } = useHub();
  const tx = useTx();
  const qc = useQueryClient();
  const addr = me!.address as Address;
  const q = useQuery({ queryKey: ['rewards', addr], queryFn: async () => (await client!.rewards(addr)).seasons, enabled: !!client });
  const earned = (q.data ?? []).filter((r) => r.amount);
  const claimed = useReadContracts({
    contracts: earned.map((r) => ({ address: contracts?.SeasonRewards, abi: seasonRewardsAbi, functionName: 'claimed', args: [r.season, addr], chainId: chainId as never } as const)),
    query: { enabled: !!contracts && earned.length > 0 },
  });
  const isClaimed = (season: number) => claimed.data?.[earned.findIndex((r) => r.season === season)]?.result === true;

  const claim = async (r: PlayerReward) => {
    const rc = await tx.run(`Claim season ${r.season}`, {
      address: contracts!.SeasonRewards, abi: seasonRewardsAbi, functionName: 'claim', args: [r.season, BigInt(r.amount!), r.proof!],
    });
    if (rc) await qc.invalidateQueries();
  };

  return (
    <section className="panel rewards-card">
      <h2>Season rewards</h2>
      <p className="muted small">Each season’s pool is split by settled ranked wins among verified humans and registered agents. Season {config?.season ?? 1} is in progress.</p>
      {q.isLoading ? <span className="spinner" aria-label="Loading rewards" />
        : !q.data?.length ? (
          <p className="muted">No rewards published for you yet. Play <Link to="/play">Ranked or the Human queue</Link>; rewards are published after each season ends.</p>
        ) : (
          <ul className="reward-list">
            {q.data.map((r) => {
              const expired = r.deadline > 0 && r.deadline * 1000 < Date.now();
              return (
                <li key={r.season} className="reward-row">
                  <div>
                    <b>Season {r.season}</b>
                    {r.amount ? (
                      <div className="reward-amt">{Number(formatUnits(BigInt(r.amount), r.tokenDecimals)).toLocaleString()} {r.tokenSymbol}
                        <span className="muted small"> · as {r.kind === 'agent' ? 'agent' : 'verified human'}{r.deadline ? ` · claim by ${day(r.deadline)}` : ''}</span></div>
                    ) : <p className="muted small">{EXCLUDED[r.excluded!]}</p>}
                  </div>
                  {r.amount && (isClaimed(r.season) ? <span className="st ok">✓ Claimed</span>
                    : expired ? <span className="muted">Claim window closed</span>
                    : <button className="btn btn-primary" onClick={() => claim(r)} disabled={tx.busy}>Claim</button>)}
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}
