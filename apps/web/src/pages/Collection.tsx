import { card, COLLECTIBLE, MAX_COPIES, MAX_LEGENDARY_COPIES, RACES, RARITIES, type CardDef, type Faction, type Race, type Rarity } from '@forkfall/engine';
import { craftingAbi, faucetTokenAbi, packSaleAbi, starterDecksAbi } from '@forkfall/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatEther, formatUnits, maxUint256, parseEventLogs, type Address } from 'viem';
import { useBalance, useBlockNumber, useReadContracts } from 'wagmi';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useTx } from '../chain/Tx.tsx';
import { useHub } from '../chain/useHub.ts';
import { useOwned, type Owned } from '../chain/useOwned.ts';
import { GameCard } from '../components/GameCard.tsx';
import { PackReveal } from '../components/PackReveal.tsx';
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

  const packs = useReadContracts({
    contracts: packIds.map((id) => ({ address: c.PackSale, abi: packSaleAbi, functionName: 'packs', args: [id], chainId: cid } as const)),
  });
  const unopened = packIds
    .map((id, i) => ({ id, p: packs.data?.[i]?.result as readonly [Address, bigint, boolean] | undefined }))
    .filter((x) => x.p && !x.p[2])
    .map((x) => ({ id: x.id, revealBlock: x.p![1] }));
  const { data: block } = useBlockNumber({ chainId: cid, watch: true });
  const eth = useBalance({ address: player, chainId: cid });

  // ─── UI state ─────────────────────────────────────────────────
  const [qty, setQty] = useState(1);
  const [reveal, setReveal] = useState<{ ids: number[]; fresh: boolean[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<number | null>(null);
  const [faction, setFaction] = useState<Faction | 'all'>('all');
  const [rarity, setRarity] = useState<Rarity | 'all'>('all');
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [confirmExtras, setConfirmExtras] = useState(false);

  const total = (id: number) => (owned.get(id)?.tradeable ?? 0) + (owned.get(id)?.soulbound ?? 0);
  const ownedKinds = COLLECTIBLE.filter((cd) => total(cd.id) > 0).length;
  const now = Math.floor(Date.now() / 1000);
  const dripReady = lastDrip === 0 || now >= lastDrip + 86_400;
  const lowEth = eth.data && eth.data.value < 200_000_000_000_000n; // < 0.0002 ETH

  // ─── Actions ──────────────────────────────────────────────────
  const claim = async (race: Race) => {
    const rc = await tx.run(`Claim ${RACE_INFO[race].name} starter deck`, { address: c.StarterDecks, abi: starterDecksAbi, functionName: 'claim', args: [RACE_CODE[race]] });
    if (rc) refresh();
  };

  const buyEth = async () => {
    if (!ethPrice) return;
    const rc = await tx.run(`Buy ${qty} pack${qty > 1 ? 's' : ''}`, { address: c.PackSale, abi: packSaleAbi, functionName: 'buyWithEth', args: [BigInt(qty)], value: ethPrice * BigInt(qty) });
    if (rc) refresh();
  };

  const buyUsdc = async () => {
    if (!usdcPrice) return;
    const cost = usdcPrice * BigInt(qty);
    if (allowance < cost) {
      const ok = await tx.run('Approve test USDC', { address: c.TestUSDC, abi: faucetTokenAbi, functionName: 'approve', args: [c.PackSale, maxUint256] });
      if (!ok) return;
    }
    const rc = await tx.run(`Buy ${qty} pack${qty > 1 ? 's' : ''} with tUSDC`, { address: c.PackSale, abi: packSaleAbi, functionName: 'buyWithToken', args: [c.TestUSDC, BigInt(qty)] });
    if (rc) refresh();
  };

  const drip = async () => {
    const rc = await tx.run('Get test USDC', { address: c.TestUSDC, abi: faucetTokenAbi, functionName: 'drip' });
    if (rc) refresh();
  };

  const open = async (id: bigint) => {
    setNotice(null);
    const before = new Map(COLLECTIBLE.map((cd) => [cd.id, total(cd.id)]));
    const rc = await tx.run(`Open pack #${id}`, { address: c.PackSale, abi: packSaleAbi, functionName: 'open', args: [id] });
    if (!rc) return;
    const logs = parseEventLogs({ abi: packSaleAbi, logs: rc.logs });
    const opened = logs.find((l) => l.eventName === 'PackOpened');
    if (opened && opened.eventName === 'PackOpened') {
      const ids = opened.args.cardIds.map(Number);
      const seen = new Map(before);
      const fresh = ids.map((cid2) => { const was = seen.get(cid2) ?? 0; seen.set(cid2, was + 1); return was === 0; });
      setReveal({ ids, fresh });
    } else if (logs.some((l) => l.eventName === 'PackRecommitted')) {
      setNotice(`Pack #${id} waited too long (over 256 blocks), so it was re-sealed to a new block. Open it again in a few seconds.`);
    }
    refresh();
  };

  const extras = COLLECTIBLE.map((cd) => {
    const o = owned.get(cd.id) ?? { tradeable: 0, soulbound: 0 };
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
    (faction === 'all' || cd.faction === faction) && (rarity === 'all' || cd.rarity === rarity) && (!ownedOnly || total(cd.id) > 0));

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
            <div className="pack-art big" aria-hidden><img src={LOGO_MARK} alt="" /><span>SET 1</span></div>
            <div className="shop-body">
              <h3>Set 1 booster</h3>
              <p className="muted">5 cards: 3 Common, 1 Uncommon, 1 Rare, which upgrades to <b>Legendary</b> about 1 in 10. Each pack is sealed to a future block and opened a few seconds later, so nobody can pick the result.</p>
              <div className="qty" role="group" aria-label="Number of packs">
                <button className="btn" onClick={() => setQty((q) => Math.max(1, q - 1))} disabled={qty <= 1} aria-label="Fewer">−</button>
                <span><b>{qty}</b> pack{qty > 1 ? 's' : ''}</span>
                <button className="btn" onClick={() => setQty((q) => Math.min(10, q + 1))} disabled={qty >= 10} aria-label="More">+</button>
              </div>
              <div className="buy-row">
                <button className="btn btn-primary" disabled={tx.busy || !ethPrice} onClick={buyEth}>
                  Buy for {ethPrice ? `${formatEther(ethPrice * BigInt(qty))} ETH` : '…'}
                </button>
                <button className="btn" disabled={tx.busy || !usdcPrice || usdcBal < (usdcPrice ?? 0n) * BigInt(qty)} onClick={buyUsdc}
                  title={usdcBal < (usdcPrice ?? 0n) * BigInt(qty) ? 'Not enough test USDC' : undefined}>
                  Buy for {usdcPrice ? `${formatUnits(usdcPrice * BigInt(qty), 6)} tUSDC` : '…'}
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
            <h3>Your sealed packs <span className="muted">({unopened.length})</span></h3>
            {notice && <div className="alert info"><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss">✕</button></div>}
            {unopened.length === 0 ? <p className="muted">No sealed packs. Buy one to get started.</p> : (
              <ul className="pack-list">
                {unopened.map(({ id, revealBlock }) => {
                  const ready = block !== undefined && block > revealBlock;
                  const wait = block !== undefined ? Number(revealBlock - block + 1n) : null;
                  return (
                    <li key={String(id)} className="pack-row">
                      <div className="pack-art" aria-hidden><img src={LOGO_MARK} alt="" /></div>
                      <div className="pr-text"><b>Pack #{String(id)}</b><small className="muted">{ready ? 'Ready to open' : wait !== null ? `Sealing… ${wait} block${wait === 1 ? '' : 's'}` : '…'}</small></div>
                      <button className="btn btn-primary" disabled={!ready || tx.busy} onClick={() => open(id)}>Open</button>
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
            const o = owned.get(cd.id) ?? { tradeable: 0, soulbound: 0 };
            const n = o.tradeable + o.soulbound;
            return (
              <div key={cd.id} className={`grid-cell ${n === 0 ? 'missing' : ''}`}>
                <GameCard cardId={cd.id} size="hand" onClick={() => setDetail(cd.id)} label={`${cd.name}, ${n} owned. Details`} />
                <span className={`own-badge ${n === 0 ? 'zero' : ''}`}>{n === 0 ? 'Not owned' : `×${n}`}{o.soulbound > 0 && <i title={`${o.soulbound} soulbound starter cop${o.soulbound === 1 ? 'y' : 'ies'}`}>◆{o.soulbound}</i>}</span>
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
          }}
          onCraft={async () => {
            const rc = await tx.run(`Craft ${card(detail).name}`, { address: c.Crafting, abi: craftingAbi, functionName: 'craft', args: [BigInt(detail)] });
            if (rc) refresh();
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
        <PackReveal ids={reveal.ids} fresh={reveal.fresh} onClose={() => setReveal(null)}
          next={unopened.find((p) => block !== undefined && block > p.revealBlock)
            ? () => { const p = unopened.find((x) => block! > x.revealBlock)!; setReveal(null); open(p.id); } : undefined} />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="stat"><span>{label}</span><b>{value}</b></div>;
}

function CardDetail({ cd, owned, scrap, scrapValue, craftCost, busy, onClose, onScrap, onCraft }: {
  cd: CardDef; owned: Owned; scrap: number; scrapValue: number; craftCost: number; busy: boolean;
  onClose: () => void; onScrap: (n: number) => void; onCraft: () => void;
}) {
  const [n, setN] = useState(1);
  const canScrap = owned.tradeable > 0;
  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal card-detail" role="dialog" aria-modal="true" aria-label={cd.name}>
        <div className="modal-head"><h2>{cd.name}</h2><button className="icon-btn" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="cd-body">
          <GameCard cardId={cd.id} size="preview" />
          <div className="cd-side">
            <dl className="kv">
              <dt>Rarity</dt><dd style={{ textTransform: 'capitalize' }}>{cd.rarity}</dd>
              <dt>Tradeable</dt><dd>{owned.tradeable}</dd>
              <dt>Soulbound</dt><dd>{owned.soulbound}</dd>
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
                  <button className="btn" disabled={busy} onClick={() => onScrap(n)}>Scrap {n} for +{n * scrapValue}</button>
                </>
              ) : <p className="muted small">{owned.soulbound ? 'Soulbound starter copies can’t be scrapped.' : 'You have no copies to scrap.'}</p>}
            </div>
            <div className="cd-action">
              <h3>Craft</h3>
              <p className="muted small">Costs {craftCost} Scrap{scrap < craftCost ? ` · you need ${craftCost - scrap} more` : ''}.</p>
              <button className="btn btn-primary" disabled={busy || scrap < craftCost} onClick={onCraft}>Craft one</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
