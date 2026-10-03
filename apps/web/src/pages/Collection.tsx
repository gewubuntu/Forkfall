import {
  card, COLLECTIBLE, COSMETIC_SETS, COSMETICS, MAX_COPIES, MAX_LEGENDARY_COPIES, milestoneMet, RACES, RARITIES, setOf,
  type CardDef, type Faction, type MilestoneRule, type Race, type Rarity,
} from '@forkfall/engine';
import { craftingAbi, faucetTokenAbi, packSaleAbi, starterDecksAbi } from '@forkfall/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { formatEther, formatUnits, maxUint256, parseEventLogs, type Address } from 'viem';
import { useBalance, useBlockNumber, useReadContract, useReadContracts } from 'wagmi';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useTx } from '../chain/Tx.tsx';
import { useHub } from '../chain/useHub.ts';
import { useOwned, type Owned } from '../chain/useOwned.ts';
import { GameCard } from '../components/GameCard.tsx';
import { PackReveal } from '../components/PackReveal.tsx';
import { FOIL_OFFSET } from '../chain/useOwned.ts';
import { TiltCard } from '../components/TiltCard.tsx';
import { PullFeed } from '../components/PullFeed.tsx';
import { useParticles } from '../lib/particles.ts';
import { sfx } from '../lib/sfx.ts';
import { useMyCosmetics } from '../lib/cosmetics.ts';
import { RACE_COLOR, RACE_INFO } from '../game/meta.ts';
import { LOGO_MARK, spriteSvg } from '../lib/art.ts';

const RACE_CODE: Record<Race, number> = { agents: 1, prophets: 2, brokers: 3, degens: 4 };
const RARITY_CODE: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2, legendary: 3 };
const ETH_FAUCET = 'https://portal.cdp.coinbase.com/products/faucet';


export function Collection() {
  const { contracts, chainId } = useHub();
  if (!contracts) {
    return (
      <div className="page"><div className="panel empty">
        <h2>Collection isn’t live yet</h2>
        <p>The card contracts aren’t deployed on this hub, or the referee is running off-chain. Once the Base Sepolia deployment is in, your starter decks, packs and cards appear here.</p>
        <Link className="btn" to="/play">Play a practice match instead</Link>
      </div></div>
    );
  }
  return <CollectionLive chainId={chainId} />;
}

function CollectionLive({ chainId }: { chainId: number }) {
  const { contracts } = useHub();
  const c = contracts!;
  const { me } = useAuth();
  const player = me!.address as Address;
  const { equipped } = useMyCosmetics();
  const qc = useQueryClient();
  const tx = useTx();
  const refresh = () => qc.invalidateQueries();
  const cid = chainId as never;

  // ─── Reads ────────────────────────────────────────────────────
  const balances = useOwned(player);
  const owned = balances.owned;

  const reads = useReadContracts({
    contracts: [
      ...RACES.map((r) => ({ address: c.StarterDecks, abi: starterDecksAbi, functionName: 'claimed', args: [player, RACE_CODE[r]], chainId: cid } as const)),
      { address: c.PackSale, abi: packSaleAbi, functionName: 'ethPrice', chainId: cid },
      { address: c.PackSale, abi: packSaleAbi, functionName: 'tokenPrice', args: [c.TestUSDC], chainId: cid },
      { address: c.Crafting, abi: craftingAbi, functionName: 'scrap', args: [player], chainId: cid },
      { address: c.TestUSDC, abi: faucetTokenAbi, functionName: 'balanceOf', args: [player], chainId: cid },
      { address: c.TestUSDC, abi: faucetTokenAbi, functionName: 'allowance', args: [player, c.PackSale], chainId: cid },
      { address: c.TestUSDC, abi: faucetTokenAbi, functionName: 'lastDrip', args: [player], chainId: cid },
      { address: c.TestUSDC, abi: faucetTokenAbi, functionName: 'dripAmount', chainId: cid },
      { address: c.PackSale, abi: packSaleAbi, functionName: 'packIdsOf', args: [player], chainId: cid },
      ...[0, 1, 2, 3].map((r) => ({ address: c.Crafting, abi: craftingAbi, functionName: 'scrapValue', args: [BigInt(r)], chainId: cid } as const)),
      ...[0, 1, 2, 3].map((r) => ({ address: c.Crafting, abi: craftingAbi, functionName: 'craftCost', args: [BigInt(r)], chainId: cid } as const)),
      { address: c.PackSale, abi: packSaleAbi, functionName: 'packsUntilPity', args: [player], chainId: cid },
    ],
  });
  const r = reads.data?.map((x) => x.result);
  const claimed = RACES.map((_, i) => r?.[i] as boolean | undefined);
  const ethPrice = r?.[4] as bigint | undefined;
  const usdcPrice = r?.[5] as bigint | undefined;
  const scrap = Number((r?.[6] as bigint | undefined) ?? 0n);
  const usdcBal = (r?.[7] as bigint | undefined) ?? 0n;
  const allowance = (r?.[8] as bigint | undefined) ?? 0n;
  const lastDrip = Number((r?.[9] as bigint | undefined) ?? 0n);
  const dripAmount = (r?.[10] as bigint | undefined) ?? 0n;
  const packIds = (r?.[11] as readonly bigint[] | undefined) ?? [];
  const scrapValue = [12, 13, 14, 15].map((i) => Number((r?.[i] as bigint | undefined) ?? 0n));
  const craftCost = [16, 17, 18, 19].map((i) => Number((r?.[i] as bigint | undefined) ?? 0n));
  /** Packs until the pity timer guarantees a Legendary (undefined on an older PackSale without it). */
  const untilPity = r?.[20] !== undefined ? Number(r[20] as bigint) : undefined;

  // Per pack: its state, whether its randomness is in (packReady), and whether it waits on Chainlink VRF.
  const packs = useReadContracts({
    contracts: packIds.flatMap((id) => [
      { address: c.PackSale, abi: packSaleAbi, functionName: 'packs', args: [id], chainId: cid } as const,
      { address: c.PackSale, abi: packSaleAbi, functionName: 'packReady', args: [id], chainId: cid } as const,
      { address: c.PackSale, abi: packSaleAbi, functionName: 'retryableAt', args: [id], chainId: cid } as const,
    ]),
  });
  // VRF packs open oldest first: which one is next, and whether a pack already has its word.
  const nextVrfRead = useReadContract({ address: c.PackSale, abi: packSaleAbi, functionName: 'nextVrfPack', args: [player], chainId: cid });
  const words = useReadContracts({
    contracts: packIds.map((id) => ({ address: c.PackSale, abi: packSaleAbi, functionName: 'vrfWordOf', args: [id], chainId: cid } as const)),
  });
  const nextVrf = nextVrfRead.data as bigint | undefined;
  const { data: block } = useBlockNumber({ chainId: cid, watch: true });
  const unopened = packIds
    .map((id, i) => ({
      id,
      p: packs.data?.[i * 3]?.result as readonly [Address, bigint, boolean, number] | undefined,
      ready: packs.data?.[i * 3 + 1]?.result as boolean | undefined,
      /** Waiting on Chainlink VRF; from this block its owner may request again (0n = not waiting). */
      retryAt: (packs.data?.[i * 3 + 2]?.result as bigint | undefined) ?? 0n,
      seeded: ((words.data?.[i]?.result as bigint | undefined) ?? 0n) > 0n,
    }))
    .filter((x) => x.p && !x.p[2])
    .map((x) => ({
      id: x.id, revealBlock: x.p![1], kind: Number(x.p![3] ?? 0) as 0 | 1, vrf: x.retryAt > 0n || x.seeded, retryAt: x.retryAt,
      /** Has its random word but an older VRF pack must be opened first. */
      queued: x.seeded && nextVrf !== undefined && nextVrf !== x.id,
      // Older PackSale deployments have no packReady: fall back to the reveal block.
      ready: x.ready ?? (block !== undefined && block > x.p![1]),
    }));
  // While a pack waits for randomness, re-read on every new block and every 3 s (VRF answers in its own
  // transaction, and block notifications can be missed); once everything is ready, stop.
  const waiting = unopened.some((p) => !p.ready);
  const refetchPacks = useCallback(() => { packs.refetch(); words.refetch(); nextVrfRead.refetch(); }, [packs.refetch, words.refetch, nextVrfRead.refetch]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (waiting) refetchPacks(); }, [block, waiting, refetchPacks]);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => refetchPacks(), 3000);
    return () => clearInterval(t);
  }, [waiting, refetchPacks]);
  const eth = useBalance({ address: player, chainId: cid });

  // ─── UI state ─────────────────────────────────────────────────
  const [qty, setQty] = useState(1);
  const [kind, setKind] = useState<0 | 1>(0);
  const [reveal, setReveal] = useState<{ ids: number[] | null; fresh: boolean[]; packId: bigint; kind: 0 | 1 } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<number | null>(null);
  const [faction, setFaction] = useState<Faction | 'all' | 'poncho'>('all');
  const [rarity, setRarity] = useState<Rarity | 'all'>('all');
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [confirmExtras, setConfirmExtras] = useState(false);

  const total = balances.total;
  const ownedKinds = COLLECTIBLE.filter((cd) => total(cd.id) > 0).length;
  const now = Math.floor(Date.now() / 1000);
  const dripReady = lastDrip === 0 || now >= lastDrip + 86_400;
  const lowEth = eth.data && eth.data.value < 200_000_000_000_000n; // < 0.0002 ETH

  // ─── Actions ──────────────────────────────────────────────────
  const claim = async (race: Race) => {
    const rc = await tx.run(`Claim ${RACE_INFO[race].name} starter deck`, { address: c.StarterDecks, abi: starterDecksAbi, functionName: 'claim', args: [RACE_CODE[race]] });
    if (rc) refresh();
  };

  const label = `${qty} ${KINDS[kind].short} pack${qty > 1 ? 's' : ''}`;
  const buyEth = async () => {
    if (!ethPrice) return;
    const rc = await tx.run(`Buy ${label}`, { address: c.PackSale, abi: packSaleAbi, functionName: 'buyWithEthOf', args: [kind, BigInt(qty)], value: bundlePrice(ethPrice, qty) });
    if (rc) refresh();
  };

  const buyUsdc = async () => {
    if (!usdcPrice) return;
    const cost = bundlePrice(usdcPrice, qty);
    if (allowance < cost) {
      const ok = await tx.run('Approve test USDC', { address: c.TestUSDC, abi: faucetTokenAbi, functionName: 'approve', args: [c.PackSale, maxUint256] });
      if (!ok) return;
    }
    const rc = await tx.run(`Buy ${label} with tUSDC`, { address: c.PackSale, abi: packSaleAbi, functionName: 'buyWithTokenOf', args: [c.TestUSDC, kind, BigInt(qty)] });
    if (rc) refresh();
  };

  const drip = async () => {
    const rc = await tx.run('Get test USDC', { address: c.TestUSDC, abi: faucetTokenAbi, functionName: 'drip' });
    if (rc) refresh();
  };

  const open = async (id: bigint) => {
    setNotice(null);
    const before = new Map(COLLECTIBLE.map((cd) => [cd.id, total(cd.id)]));
    setReveal({ ids: null, fresh: [], packId: id, kind: unopened.find((u) => u.id === id)?.kind ?? 0 }); // the pack wobbles on stage while the transaction confirms
    const rc = await tx.run(`Open pack #${id}`, { address: c.PackSale, abi: packSaleAbi, functionName: 'open', args: [id] });
    if (!rc) { setReveal(null); return; }
    const logs = parseEventLogs({ abi: packSaleAbi, logs: rc.logs });
    const opened = logs.find((l) => l.eventName === 'PackOpened');
    if (opened && opened.eventName === 'PackOpened') {
      const ids = opened.args.cardIds.map(Number);
      const seen = new Map(before);
      const fresh = ids.map((raw) => { const cid2 = raw >= FOIL_OFFSET ? raw - FOIL_OFFSET : raw; const was = seen.get(cid2) ?? 0; seen.set(cid2, was + 1); return was === 0; });
      setReveal((r0) => ({ ids, fresh, packId: id, kind: r0?.kind ?? 0 }));
    } else {
      setReveal(null);
    }
    if (!opened && logs.some((l) => l.eventName === 'PackRecommitted')) {
      setNotice(`Pack #${id} was re-sealed to a new block (it waited too long, or its randomness source changed). Open it again in a few seconds.`);
    }
    refresh();
  };

  const retry = async (id: bigint) => {
    const rc = await tx.run(`Request randomness again for pack #${id}`, { address: c.PackSale, abi: packSaleAbi, functionName: 'retryRandomness', args: [id] });
    if (rc) refresh();
  };

  const extras = COLLECTIBLE.map((cd) => {
    const o = owned.get(cd.id) ?? { tradeable: 0, soulbound: 0, foil: 0 };
    const limit = cd.rarity === 'legendary' ? MAX_LEGENDARY_COPIES : MAX_COPIES;
    const keepTradeable = Math.max(0, limit - o.soulbound);
    return { cd, n: Math.max(0, o.tradeable - keepTradeable) };
  }).filter((x) => x.n > 0);
  const extrasScrap = extras.reduce((a, x) => a + x.n * scrapValue[RARITY_CODE[x.cd.rarity]], 0);

  const scrapExtras = async () => {
    setConfirmExtras(false);
    const rc = await tx.run('Scrap extra copies', {
      address: c.Crafting, abi: craftingAbi, functionName: 'scrapCards',
      args: [extras.map((x) => BigInt(x.cd.id)), extras.map((x) => BigInt(x.n))],
    });
    if (rc) refresh();
  };

  const shown = COLLECTIBLE.filter((cd) =>
    (faction === 'all' || (faction === 'poncho' ? setOf(cd) === 'poncho' : cd.faction === faction)) && (rarity === 'all' || cd.rarity === rarity) && (!ownedOnly || total(cd.id) > 0));

  const loading = balances.isLoading || reads.isLoading;

  return (
    <div className="page collection">
      <div className="coll-head">
        <h1>Collection</h1>
        <div className="stat-row">
          <Stat label="Cards owned" value={loading ? '…' : `${ownedKinds} / ${COLLECTIBLE.length}`} />
          <Stat label="Scrap" value={loading ? '…' : String(scrap)} />
          <Stat label="Test USDC" value={loading ? '…' : formatUnits(usdcBal, 6)} />
          <Stat label="ETH" value={eth.data ? Number(formatEther(eth.data.value)).toFixed(4) : '…'} />
        </div>
      </div>
      {lowEth && (
        <div className="alert info">
          <span>You need a little testnet ETH for gas.{' '}
            {chainId === 84532 ? <a href={ETH_FAUCET} target="_blank" rel="noreferrer">Get free Base Sepolia ETH ↗</a> : 'Fund this wallet on the local chain.'}
          </span>
        </div>
      )}
      {(balances.error || reads.error) && <div className="alert err">Couldn’t read the chain: {(balances.error ?? reads.error)!.message.split('\n')[0]}</div>}

      <SetProgress total={total} loading={loading} />

      {/* ─── Starter decks ─── */}
      <section aria-labelledby="starter-h">
        <h2 id="starter-h" className="sub">Free starter decks</h2>
        <p className="muted section-lead">One 30-card deck per race, free. Starter copies are soulbound: they can’t be sold, traded or scrapped, and they’re legal in every mode, including ranked.</p>
        <div className="starter-grid">
          {RACES.map((race, i) => (
            <div key={race} className={`starter ${claimed[i] ? 'done' : ''}`} style={{ ['--rc' as string]: RACE_COLOR[race] }}>
              <img src={spriteSvg(RACE_INFO[race].sprite)} alt="" />
              <div className="st-text">
                <b>{RACE_INFO[race].name}</b>
                <small>{RACE_INFO[race].chain} · 30 cards</small>
              </div>
              {claimed[i] === undefined ? <span className="spinner" />
                : claimed[i] ? <span className="badge human">✓ Claimed</span>
                : <button className="btn btn-primary" disabled={tx.busy} onClick={() => claim(race)}>Claim</button>}
            </div>
          ))}
        </div>
      </section>

      {/* ─── Packs ─── */}
      <section aria-labelledby="packs-h">
        <h2 id="packs-h" className="sub">Packs</h2>
        <div className="packs-layout">
          <div className="panel shop">
            <div className={`pack-art big kind-${kind}`} aria-hidden><img src={kind === 1 ? spriteSvg(48) : LOGO_MARK} alt="" /><span>{KINDS[kind].short.toUpperCase()}</span></div>
            <div className="shop-body">
              <div className="kind-tabs" role="radiogroup" aria-label="Booster">
                {KINDS.map((k, i) => (
                  <button key={k.name} role="radio" aria-checked={kind === i} className={kind === i ? 'on' : ''} onClick={() => setKind(i as 0 | 1)}>{k.name}</button>
                ))}
              </div>
              <p className="muted">{KINDS[kind].blurb} Each pack is sealed to a future block and opened a few seconds later, so nobody can pick the result.</p>
              <ul className="pack-perks">
                <li><b>Pity timer:</b> {untilPity !== undefined ? <>a Legendary is guaranteed within <b className="pity-n">{untilPity}</b> more pack{untilPity === 1 ? '' : 's'}.</> : 'a Legendary is guaranteed within 20 packs.'}</li>
                <li><b>No dead duplicates:</b> you won’t get a 3rd copy (2nd of a Legendary) until you own the playset of that rarity.</li>
                <li><b>✦ Foils:</b> about 1 card in 15 is a foil. Same card in play, animated holo, scraps for 4×.</li>
                <li><b>🎁 Free packs:</b> complete your daily quests (on <Link to="/play">Play</Link>) to earn a free pack; quests also pay Scrap for crafting.</li>
              </ul>
              <details className="odds"><summary>Published odds</summary>
                <table><tbody>
                  <tr><td>Slots 1–3</td><td>Common</td><td>100%</td></tr>
                  <tr><td>Slot 4</td><td>Uncommon</td><td>100%</td></tr>
                  <tr><td>Slot 5</td><td>Rare / Legendary</td><td>90% / 10% (100% at pity)</td></tr>
                  <tr><td>Any card</td><td>Foil</td><td>6.67%</td></tr>
                </tbody></table>
                <p className="muted small">Enforced by the PackSale contract; the cards come from a future block hash (testnet; VRF before mainnet).</p>
              </details>
              <div className="bundles" role="radiogroup" aria-label="Bundle">
                {BUNDLES.map((b) => (
                  <button key={b.n} role="radio" aria-checked={qty === b.n} className={`bundle ${qty === b.n ? 'on' : ''}`} onClick={() => setQty(b.n)}>
                    <b>{b.n} pack{b.n > 1 ? 's' : ''}</b>
                    {b.off ? <span className="save">−{b.off}%</span> : <span className="muted small">single</span>}
                    {ethPrice ? <small>{formatEther(bundlePrice(ethPrice, b.n))} ETH</small> : null}
                  </button>
                ))}
              </div>
              <div className="qty" role="group" aria-label="Number of packs">
                <button className="btn" onClick={() => setQty((q) => Math.max(1, q - 1))} disabled={qty <= 1} aria-label="Fewer">−</button>
                <span><b>{qty}</b> pack{qty > 1 ? 's' : ''}{qty >= 5 && <span className="save"> −{qty >= 10 ? 15 : 10}%</span>}</span>
                <button className="btn" onClick={() => setQty((q) => Math.min(10, q + 1))} disabled={qty >= 10} aria-label="More">+</button>
              </div>
              <div className="buy-row">
                <button className="btn btn-primary" disabled={tx.busy || !ethPrice} onClick={buyEth}>
                  Buy for {ethPrice ? `${formatEther(bundlePrice(ethPrice, qty))} ETH` : '…'}
                </button>
                <button className="btn" disabled={tx.busy || !usdcPrice || usdcBal < bundlePrice(usdcPrice ?? 0n, qty)} onClick={buyUsdc}
                  title={usdcBal < bundlePrice(usdcPrice ?? 0n, qty) ? 'Not enough test USDC' : undefined}>
                  Buy for {usdcPrice ? `${formatUnits(bundlePrice(usdcPrice, qty), 6)} tUSDC` : '…'}
                </button>
              </div>
              <div className="faucet">
                <span className="muted small">Test USDC balance: {formatUnits(usdcBal, 6)}</span>
                <button className="btn btn-ghost" disabled={tx.busy || !dripReady} onClick={drip}>
                  {dripReady ? `Get ${formatUnits(dripAmount, 6)} free tUSDC` : `Faucet again ${new Date((lastDrip + 86_400) * 1000).toLocaleString()}`}
                </button>
              </div>
            </div>
          </div>

          <div className="panel unopened">
<PullFeed packSale={c.PackSale} chainId={chainId} me={player} />
                        <h3>Your sealed packs <span className="muted">({unopened.length})</span></h3>
            {notice && <div className="alert info"><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss">✕</button></div>}
            {unopened.length === 0 ? <p className="muted">No sealed packs. Buy one to get started.</p> : (
              <ul className="pack-list">
                {unopened.map(({ id, revealBlock, kind: k, ready, vrf, retryAt, queued }) => {
                  const canRetry = retryAt > 0n && !ready && block !== undefined && block >= retryAt;
                  const wait = block !== undefined ? Number(revealBlock - block + 1n) : null;
                  return (
                    <li key={String(id)} className="pack-row">
                      <div className={`pack-art kind-${k}`} aria-hidden><img src={k === 1 ? spriteSvg(48) : LOGO_MARK} alt="" /></div>
                      <div className="pr-text"><b>{KINDS[k]?.short ?? 'Set 1'} pack #{String(id)}</b><small className="muted">{ready ? 'Ready to open' : queued ? 'Randomness in: open your older packs first' : vrf ? 'Waiting for verifiable randomness (Chainlink VRF)…' : wait !== null && wait > 0 ? `Sealing… ${wait} block${wait === 1 ? '' : 's'}` : '…'}</small></div>
                      {canRetry
                        ? <button className="btn" disabled={tx.busy} onClick={() => retry(id)} title="Chainlink hasn't answered for a while: ask again (the first answer to arrive counts)">Request again</button>
                        : <button className="btn btn-primary" disabled={!ready || tx.busy} onClick={() => open(id)}>Open</button>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* ─── Cards ─── */}
      <section aria-labelledby="cards-h">
        <div className="cards-head">
          <h2 id="cards-h" className="sub">Your cards</h2>
          <div className="filters">
            <div className="chips" role="group" aria-label="Faction">
              {(['all', ...RACES, 'neutral'] as const).map((f) => (
                <button key={f} className={`chip-btn ${faction === f ? 'on' : ''}`} style={f !== 'all' ? { ['--rc' as string]: RACE_COLOR[f] } : undefined}
                  aria-pressed={faction === f} onClick={() => setFaction(f)}>
                  {f === 'all' ? 'All' : f === 'neutral' ? 'Neutral' : RACE_INFO[f].name}
                </button>
              ))}
              <button className={`chip-btn ${faction === 'poncho' ? 'on' : ''}`} style={{ ['--rc' as string]: 'var(--poncho)' }}
                aria-pressed={faction === 'poncho'} onClick={() => setFaction('poncho')} title="Poncho collab set: neutral cards from Base, playable in any deck">
                🌮 Poncho set
              </button>
            </div>
            <select value={rarity} onChange={(e) => setRarity(e.target.value as Rarity | 'all')} aria-label="Rarity">
              <option value="all">All rarities</option>
              {RARITIES.map((x) => <option key={x} value={x}>{x[0].toUpperCase() + x.slice(1)}</option>)}
            </select>
            <label className="toggle"><input type="checkbox" checked={ownedOnly} onChange={(e) => setOwnedOnly(e.target.checked)} /> Owned only</label>
            <button className="btn" disabled={tx.busy || extras.length === 0} onClick={() => setConfirmExtras(true)}
              title="Scrap tradeable copies beyond what a deck can use">
              Scrap extras{extras.length ? ` (+${extrasScrap})` : ''}
            </button>
          </div>
        </div>
        <div className="card-grid">
          {shown.map((cd) => {
            const o = owned.get(cd.id) ?? { tradeable: 0, soulbound: 0, foil: 0 };
            const n = o.tradeable + o.soulbound + o.foil;
            return (
              <div key={cd.id} className={`grid-cell ${n === 0 ? 'missing' : ''}`}>
                <TiltCard rarity={o.foil ? 'legendary' : cd.rarity}><GameCard cardId={cd.id} size="hand" foil={o.foil > 0} onClick={() => setDetail(cd.id)} label={`${cd.name}, ${n} owned. Details`} /></TiltCard>
                <span className={`own-badge ${n === 0 ? 'zero' : ''}`}>{n === 0 ? 'Not owned' : `×${n}`}{o.soulbound > 0 && <i title={`${o.soulbound} soulbound starter cop${o.soulbound === 1 ? 'y' : 'ies'}`}>◆{o.soulbound}</i>}{o.foil > 0 && <i className="foil-count" title={`${o.foil} foil${o.foil === 1 ? '' : 's'}`}>✦{o.foil}</i>}</span>
              </div>
            );
          })}
          {shown.length === 0 && <p className="muted">No cards match these filters.</p>}
        </div>
      </section>

      {detail !== null && (
        <CardDetail
          cd={card(detail)} owned={owned.get(detail)!} scrap={scrap}
          scrapValue={scrapValue[RARITY_CODE[card(detail).rarity]]} craftCost={craftCost[RARITY_CODE[card(detail).rarity]]}
          busy={tx.busy} onClose={() => setDetail(null)}
          onScrap={async (n) => {
            const rc = await tx.run(`Scrap ${n}× ${card(detail).name}`, { address: c.Crafting, abi: craftingAbi, functionName: 'scrapCards', args: [[BigInt(detail)], [BigInt(n)]] });
            if (rc) refresh();
            return !!rc;
          }}
          onCraft={async () => {
            const rc = await tx.run(`Craft ${card(detail).name}`, { address: c.Crafting, abi: craftingAbi, functionName: 'craft', args: [BigInt(detail)] });
            if (rc) refresh();
            return !!rc;
          }}
        />
      )}

      {confirmExtras && (
        <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmExtras(false); }}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="Scrap extra copies">
            <div className="modal-head"><h2>Scrap extras</h2><button className="icon-btn" onClick={() => setConfirmExtras(false)} aria-label="Close">✕</button></div>
            <p className="muted">These tradeable copies are beyond what a deck can use (2 per card, 1 per Legendary, counting your soulbound copies). They’ll be burned for <b>{extrasScrap} Scrap</b>.</p>
            <ul className="extras-list">{extras.map((x) => <li key={x.cd.id}><span>{x.cd.name}</span><span className="muted">{x.n}× · +{x.n * scrapValue[RARITY_CODE[x.cd.rarity]]}</span></li>)}</ul>
            <div className="row-end"><button className="btn" onClick={() => setConfirmExtras(false)}>Cancel</button><button className="btn btn-primary" onClick={scrapExtras}>Scrap for {extrasScrap}</button></div>
          </div>
        </div>
      )}

      {reveal && (
        <PackReveal key={String(reveal.packId)} ids={reveal.ids} fresh={reveal.fresh} packId={reveal.packId} kind={reveal.kind} player={player} back={equipped.cardBack} onClose={() => setReveal(null)}
          next={unopened.find((p) => p.ready && p.id !== reveal.packId)
            ? () => { const p = unopened.find((x) => x.ready && x.id !== reveal.packId)!; setReveal(null); open(p.id); } : undefined} />
      )}
    </div>
  );
}

const SET_COLOR: Record<string, string> = { ...RACE_COLOR, poncho: 'var(--poncho)' };
const RULE_LABEL: Record<MilestoneRule, string> = { tutorial: 'Tutorial', lessons: 'Every lesson', commons: 'All Commons', every: 'Every card', playset: 'Full playset' };

/** Collection goals: progress per set (cards owned, playset copies) and the cosmetics each milestone unlocks. */
function SetProgress({ total, loading }: { total: (id: number) => number; loading: boolean }) {
  return (
    <section aria-labelledby="sets-h">
      <h2 id="sets-h" className="sub">Set progress</h2>
      <p className="muted section-lead">Milestones unlock cosmetics: a card back, a title and an animated badge per set. <Link to="/profile">Equip them on your Profile</Link>; opponents see them in matches.</p>
      <div className="set-grid">
        {COSMETIC_SETS.map((s) => {
          const owned = s.cards.filter((c) => total(c.id) > 0).length;
          const copies = s.cards.reduce((a, c) => a + Math.min(total(c.id), c.rarity === 'legendary' ? 1 : 2), 0);
          const need = s.cards.reduce((a, c) => a + (c.rarity === 'legendary' ? 1 : 2), 0);
          return (
            <div key={s.key} className="set-card" style={{ ['--rc' as string]: SET_COLOR[s.key] }}>
              <div className="set-top"><b>{s.label}</b><span>{loading ? '…' : `${owned}/${s.cards.length}`}</span></div>
              <div className="set-bar" role="meter" aria-valuemin={0} aria-valuemax={need} aria-valuenow={copies} aria-label={`${s.label} playset progress`}>
                <i style={{ width: `${(copies / need) * 100}%` }} />
              </div>
              <ul className="set-ms">
                {COSMETICS.filter((m) => m.set === s.key).map((m) => {
                  const done = !loading && milestoneMet(m.rule, m.set, total, []);
                  return <li key={m.id} className={done ? 'done' : ''} title={`${m.description} Unlocks: ${m.name}`}>{done ? '✓' : '○'} {RULE_LABEL[m.rule]} <span className="muted">· {m.name}</span></li>;
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Booster kinds sold by PackSale (kind 0 = every card; 1 = the Poncho collab pool). */
const KINDS = [
  { name: 'Set 1 booster', short: 'Set 1', blurb: '5 cards from the whole set: 3 Common, 1 Uncommon, 1 Rare, which upgrades to Legendary about 1 in 10.' },
  { name: 'Poncho booster', short: 'Poncho', blurb: '5 Poncho collab cards only: 3 Common, 1 Uncommon, 1 Rare (Mariachi Cat), which upgrades to Poncho himself about 1 in 10.' },
] as const;
const BUNDLES = [{ n: 1, off: 0 }, { n: 5, off: 10 }, { n: 10, off: 15 }];
/** Same as PackSale.bundlePrice: 5+ packs 10% off, 10 packs 15% off. */
const bundlePrice = (unit: bigint, n: number) => (unit * BigInt(n) * BigInt(n >= 10 ? 8500 : n >= 5 ? 9000 : 10000)) / 10000n;

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="stat"><span>{label}</span><b>{value}</b></div>;
}

function CardDetail({ cd, owned, scrap, scrapValue, craftCost, busy, onClose, onScrap, onCraft }: {
  cd: CardDef; owned: Owned; scrap: number; scrapValue: number; craftCost: number; busy: boolean;
  onClose: () => void; onScrap: (n: number) => Promise<boolean>; onCraft: () => Promise<boolean>;
}) {
  const [n, setN] = useState(1);
  const [fx, setFx] = useState<{ kind: 'craft' | 'scrap'; id: number; amount: number } | null>(null);
  const art = useRef<HTMLDivElement>(null);
  const { ref: canvas, burst } = useParticles();
  const canScrap = owned.tradeable > 0;
  const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const colors = { common: ['#9aa3b5', '#cfd6e4'], uncommon: ['#e2e8f0', '#94a3b8'], rare: ['#ffd56b', '#f59e0b', '#fff3c4'], legendary: ['#ff7ad9', '#67e8f9', '#b6f23c', '#fde68a'] }[cd.rarity];
  const center = () => { const r = art.current?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height } : null; };

  // Craft: the card is forged in a flash of light. Scrap: a copy dissolves into rising pixels.
  const craft = async () => {
    if (!(await onCraft())) return;
    setFx({ kind: 'craft', id: Date.now(), amount: craftCost });
    sfx.flip(cd.rarity);
    const c = center();
    if (c && !reduced) { burst(c.x, c.y, colors.concat('#ffffff'), 60 + (cd.rarity === 'legendary' ? 90 : 0), 9); setTimeout(() => burst(c.x, c.y, colors, 40, 6), 250); }
  };
  const scrapIt = async () => {
    const k = n;
    if (!(await onScrap(k))) return;
    setFx({ kind: 'scrap', id: Date.now(), amount: k * scrapValue });
    sfx.death();
    const c = center();
    if (c && !reduced) for (let i = 0; i < 6; i++) setTimeout(() => burst(c.x + (Math.random() - 0.5) * 120, c.y - c.h / 3 + i * (c.h / 8), colors, 14, 3), i * 70);
    setN(1);
  };
  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal card-detail" role="dialog" aria-modal="true" aria-label={cd.name}>
        <div className="modal-head"><h2>{cd.name}</h2><button className="icon-btn" onClick={onClose} aria-label="Close">✕</button></div>
        <canvas ref={canvas} className="particles cd-particles" aria-hidden />
        <div className="cd-body">
          <div ref={art} className={`cd-art ${fx ? `fx-${fx.kind}` : ''}`} key={fx?.id ?? 0}>
            <TiltCard rarity={cd.rarity} strength={16}><GameCard cardId={cd.id} size="preview" /></TiltCard>
            {fx?.kind === 'scrap' && <div className="cd-ghost" aria-hidden><GameCard cardId={cd.id} size="preview" /></div>}
            {fx && <span className={`cd-float ${fx.kind}`} aria-live="polite">{fx.kind === 'craft' ? `Crafted! −${fx.amount} Scrap` : `+${fx.amount} Scrap`}</span>}
          </div>
          <div className="cd-side">
            <dl className="kv">
              <dt>Rarity</dt><dd style={{ textTransform: 'capitalize' }}>{cd.rarity}</dd>
              <dt>Tradeable</dt><dd>{owned.tradeable}</dd>
              <dt>Soulbound</dt><dd>{owned.soulbound}</dd>
              <dt>Foil</dt><dd>{owned.foil ? `✦ ${owned.foil}` : 0}</dd>
              <dt>Your Scrap</dt><dd>{scrap}</dd>
              <dt>Token</dt><dd><a href={`/metadata/images/${cd.id}.svg`} target="_blank" rel="noreferrer">Card image ↗</a> · <a href={`/metadata/cards/${cd.id}.json`} target="_blank" rel="noreferrer">metadata ↗</a></dd>
            </dl>
            <div className="cd-action">
              <h3>Scrap</h3>
              {canScrap ? (
                <>
                  <div className="qty small-qty">
                    <button className="btn" onClick={() => setN((x) => Math.max(1, x - 1))} disabled={n <= 1} aria-label="Fewer">−</button>
                    <span><b>{n}</b> of {owned.tradeable}</span>
                    <button className="btn" onClick={() => setN((x) => Math.min(owned.tradeable, x + 1))} disabled={n >= owned.tradeable} aria-label="More">+</button>
                  </div>
                  <button className="btn" disabled={busy} onClick={scrapIt}>Scrap {n} for +{n * scrapValue}</button>
                </>
              ) : <p className="muted small">{owned.soulbound ? 'Soulbound starter copies can’t be scrapped.' : 'You have no copies to scrap.'}</p>}
            </div>
            <div className="cd-action">
              <h3>Craft</h3>
              <p className="muted small">Costs {craftCost} Scrap{scrap < craftCost ? ` · you need ${craftCost - scrap} more` : ''}.</p>
              <button className="btn btn-primary" disabled={busy || scrap < craftCost} onClick={craft}>Craft one</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
