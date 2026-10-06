import { trackTotals, XP_FIRST_WIN, XP_MATCH_PLAYED, XP_MATCH_WON, XP_QUEST } from '@forkfall/engine';
import { faucetTokenAbi, seasonPassAbi, type PassStatus, type QuestPayoutStatus } from '@forkfall/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatEther, formatUnits, isAddress, maxUint256, type Address } from 'viem';
import { useReadContracts } from 'wagmi';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useTx } from '../chain/Tx.tsx';
import { useHub } from '../chain/useHub.ts';
import { rewardIcon, rewardText, seasonLeft, tierProgress, usePass } from '../components/PassPanel.tsx';

const FREE = trackTotals('free');
const PREMIUM = trackTotals('premium');

function Paid({ p, reached }: { p?: QuestPayoutStatus; reached: boolean }) {
  if (!reached) return null;
  if (!p || p.state === 'offchain') return <span className="pt-state ok">✓</span>;
  if (p.state === 'paid') return <span className="pt-state ok" title={p.tx}>✓ Paid</span>;
  if (p.state === 'held') return <Link className="pt-state held" to="/profile" title="Verify as human on your Profile to receive it">🔒 Held</Link>;
  if (p.state === 'failed') return <span className="pt-state err" title={p.error}>Failed</span>;
  return <span className="pt-state pending" title="Sending your reward on-chain"><span className="spinner" /> Paying</span>;
}

/** The season pass: XP bar, how XP is earned, the premium track for sale, and every tier on both tracks. */
export function Pass() {
  const q = usePass();
  if (q.isLoading) return <div className="page"><span className="spinner" aria-label="Loading" /></div>;
  if (q.isError || !q.data) {
    return <div className="page"><div className="panel empty"><h2>No season pass here</h2><p>This server doesn’t run the season pass.</p></div></div>;
  }
  return <PassView s={q.data} />;
}

function PassView({ s }: { s: PassStatus }) {
  const { frac, need } = tierProgress(s);
  return (
    <div className="page pass-page">
      <header className="pass-hero">
        <div>
          <span className="pass-kicker">Season {s.season}</span>
          <h1>Season pass</h1>
          <p className="muted">
            {new Date(s.startsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} to{' '}
            {new Date(s.endsAt - 1).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ends in {seasonLeft(s.endsAt - Date.now())}
          </p>
        </div>
        <div className="pass-big">
          <b>Tier {s.tier}<span className="muted">/{s.tiers.length}</span></b>
          <div className="pass-bar big" role="progressbar" aria-label="XP to the next tier" aria-valuemin={0} aria-valuemax={s.xpPerTier} aria-valuenow={Math.round(frac * s.xpPerTier)}>
            <i style={{ width: `${frac * 100}%` }} />
          </div>
          <span className="small muted">{s.tier >= s.tiers.length ? `${s.xp} XP · pass complete` : `${s.xp} XP · ${need} XP to tier ${s.tier + 1}`}</span>
        </div>
      </header>

      <div className="pass-info">
        <section className="panel">
          <h2>Earn XP</h2>
          <ul className="xp-list">
            <li><span>Play a match</span><b>+{XP_MATCH_PLAYED}</b></li>
            <li><span>Win it</span><b>+{XP_MATCH_WON}</b></li>
            <li><span>Finish a daily quest</span><b>+{XP_QUEST}</b></li>
            <li><span>First win of the day</span><b>+{XP_FIRST_WIN}</b></li>
          </ul>
          <p className="small muted">
            Match XP today: {s.matchXpToday}/{s.matchXpCap}. Quests and the first win count on top, so a few matches a day
            fill the pass within the season. Matches need four turns each, like quests.
          </p>
        </section>
        <Premium s={s} />
      </div>

      {s.eligible === false && (
        <p className="q-gate small">
          🔒 Pass rewards go to verified humans and registered agents. Your XP counts; rewards are held and paid as soon as you{' '}
          <Link to="/profile">verify on your Profile</Link>.
        </p>
      )}
      {!s.paysOnChain && <p className="muted small">This server tracks XP but doesn’t pay rewards (it runs off-chain).</p>}

      <section aria-labelledby="tiers-h">
        <h2 id="tiers-h" className="sub">Rewards</h2>
        <div className="pass-legend small"><span className="lg free">Free</span><span className="lg prem">Premium</span></div>
        <ol className="tier-grid">
          {s.tiers.map((t) => {
            const reached = s.tier >= t.tier;
            return (
              <li key={t.tier} className={`tier ${reached ? 'reached' : ''} ${t.tier === s.tier + 1 ? 'next' : ''}`}>
                <span className="tier-n">{t.tier}</span>
                <div className={`tr free ${t.free ? '' : 'empty'}`}>
                  {t.free ? <><span className="ico">{rewardIcon(t.free)}</span><span>{rewardText(t.free)}</span><Paid p={t.freePayout} reached={reached} /></> : <span className="muted">·</span>}
                </div>
                <div className={`tr prem ${s.premium ? 'own' : 'locked'}`}>
                  <span className="ico">{rewardIcon(t.premium)}</span><span>{rewardText(t.premium)}</span>
                  {s.premium ? <Paid p={t.premiumPayout} reached={reached} /> : <span className="lock" aria-label="Premium">🔒</span>}
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

/** The premium track: what it adds, and buying it (for yourself or as a gift) with test ETH or test USDC. */
function Premium({ s }: { s: PassStatus }) {
  const { contracts, chainId } = useHub();
  const { me, client } = useAuth();
  const tx = useTx();
  const qc = useQueryClient();
  const [gift, setGift] = useState('');
  const [giftOpen, setGiftOpen] = useState(false);
  const c = contracts;
  const player = me!.address as Address;
  const cid = chainId as never;
  const reads = useReadContracts({
    contracts: c?.SeasonPass ? [
      { address: c.SeasonPass, abi: seasonPassAbi, functionName: 'ethPrice', chainId: cid },
      { address: c.SeasonPass, abi: seasonPassAbi, functionName: 'tokenPrice', args: [c.TestUSDC], chainId: cid },
      { address: c.TestUSDC, abi: faucetTokenAbi, functionName: 'allowance', args: [player, c.SeasonPass], chainId: cid },
      { address: c.TestUSDC, abi: faucetTokenAbi, functionName: 'balanceOf', args: [player], chainId: cid },
    ] : [],
  });
  const r = reads.data?.map((x) => x.result as bigint | undefined);
  const [ethPrice, usdcPrice, allowance = 0n, usdcBal = 0n] = r ?? [];

  const extra = `${PREMIUM.packs} packs, ${PREMIUM.scrap.toLocaleString()} Scrap, a season card back and an animated badge`;
  if (s.premium === null || !c?.SeasonPass) {
    return (
      <section className="panel pass-buy">
        <h2>Premium track</h2>
        <p>Adds {extra} on top of the free track ({FREE.packs} packs, {FREE.scrap} Scrap and the season title).</p>
        <p className="small muted">The premium pass isn’t sold on this server yet.</p>
      </section>
    );
  }
  if (s.premium) {
    return (
      <section className="panel pass-buy owned">
        <h2>★ Premium unlocked</h2>
        <p>You get {extra}, on top of the free track. Rewards for tiers you’d already reached were paid when you unlocked it.</p>
      </section>
    );
  }

  const badGift = giftOpen && !isAddress(gift);
  const to = giftOpen && isAddress(gift) ? (gift as Address) : player;
  const forWho = to === player ? '' : ' as a gift';
  const after = async () => {
    await client!.pass(undefined, { sync: true }).catch(() => null);
    qc.invalidateQueries({ queryKey: ['pass'] });
    reads.refetch();
  };
  const buyEth = async () => {
    if (!ethPrice) return;
    const rc = await tx.run(`Buy the season ${s.season} pass${forWho}`, { address: c.SeasonPass!, abi: seasonPassAbi, functionName: 'buyWithEth', args: [to], value: ethPrice });
    if (rc) await after();
  };
  const buyUsdc = async () => {
    if (!usdcPrice) return;
    if (allowance < usdcPrice) {
      const ok = await tx.run('Approve test USDC', { address: c.TestUSDC, abi: faucetTokenAbi, functionName: 'approve', args: [c.SeasonPass!, maxUint256] });
      if (!ok) return;
    }
    const rc = await tx.run(`Buy the season ${s.season} pass${forWho} with tUSDC`, { address: c.SeasonPass!, abi: seasonPassAbi, functionName: 'buyWithToken', args: [c.TestUSDC, to] });
    if (rc) await after();
  };
  return (
    <section className="panel pass-buy">
      <h2>Premium track</h2>
      <p>Adds <b>{extra}</b> on top of the free track. Tiers you’ve already reached pay out the moment you unlock it.</p>
      <div className="pass-actions">
        <button className="btn btn-primary" onClick={buyUsdc} disabled={tx.busy || badGift || !usdcPrice || usdcBal < (usdcPrice ?? 0n)}>
          Unlock for {usdcPrice ? formatUnits(usdcPrice, 6) : '…'} tUSDC
        </button>
        <button className="btn" onClick={buyEth} disabled={tx.busy || badGift || !ethPrice}>
          or {ethPrice ? formatEther(ethPrice) : '…'} ETH
        </button>
      </div>
      {usdcPrice !== undefined && usdcBal < usdcPrice && <p className="small muted">Not enough test USDC: get some free in your <Link to="/collection">Collection</Link>.</p>}
      <button className="pass-link small" onClick={() => setGiftOpen((v) => !v)}>{giftOpen ? 'Buy it for myself' : '🎁 Gift it to a friend'}</button>
      {giftOpen && (
        <label className="gift small">
          Friend’s wallet address
          <input value={gift} onChange={(e) => setGift(e.target.value.trim())} placeholder="0x…" spellCheck={false} />
          {gift && !isAddress(gift) && <span className="err">Not an address yet.</span>}
        </label>
      )}
    </section>
  );
}
