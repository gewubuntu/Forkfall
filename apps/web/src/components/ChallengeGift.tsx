import { faucetTokenAbi, packGiftsAbi, type ChallengeGiftView, type ChallengeView } from '@forkfall/sdk';
import { useState } from 'react';
import { formatEther, formatUnits, maxUint256, type Hex } from 'viem';
import { useReadContracts } from 'wagmi';
import { useAuth } from '../auth/AuthProvider.tsx';
import { friendlyError } from '../chain/errors.ts';
import { useTx } from '../chain/Tx.tsx';
import { useHub } from '../chain/useHub.ts';
import { shortAddr } from '../lib/format.ts';

const packs = (n: number | null) => `${n ?? 1} pack${n === 1 ? '' : 's'}`;

/**
 * On your open challenge: attach Set 1 packs for whoever plays it. Paid now into PackGifts and delivered by the
 * referee once the match ends; refundable after three days if nobody plays.
 */
export function AttachGift({ c, onChange }: { c: ChallengeView; onChange: () => void }) {
  const { contracts, chainId } = useHub();
  const { client, me } = useAuth();
  const tx = useTx();
  const [count, setCount] = useState(1);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const k = contracts;
  const cid = chainId as never;
  const reads = useReadContracts({
    contracts: k?.PackGifts && me ? [
      { address: k.PackGifts, abi: packGiftsAbi, functionName: 'quoteEth', args: [BigInt(count)], chainId: cid },
      { address: k.PackGifts, abi: packGiftsAbi, functionName: 'quoteToken', args: [k.TestUSDC, BigInt(count)], chainId: cid },
      { address: k.TestUSDC, abi: faucetTokenAbi, functionName: 'allowance', args: [me.address, k.PackGifts], chainId: cid },
      { address: k.TestUSDC, abi: faucetTokenAbi, functionName: 'balanceOf', args: [me.address], chainId: cid },
    ] : [],
  });
  if (!k?.PackGifts) return null;
  const g = c.gift;
  if (g && g.state !== 'unpaid' && g.state !== 'none') return <GiftNote g={g} mine />;
  if (c.state !== 'open') return null;

  const [eth, usdc, allowance = 0n, bal = 0n] = reads.data?.map((x) => x.result as bigint | undefined) ?? [];
  const pay = async (withToken: boolean) => {
    setErr(null);
    try {
      const { giftId } = await client!.attachGift(c.code);
      if (!giftId) throw new Error('no gift id');
      const id = giftId as Hex;
      let rc;
      if (withToken) {
        if (!usdc) return;
        if (allowance < usdc) {
          const ok = await tx.run('Approve test USDC for gifts', { address: k.TestUSDC, abi: faucetTokenAbi, functionName: 'approve', args: [k.PackGifts!, maxUint256] });
          if (!ok) return;
        }
        rc = await tx.run(`Attach ${packs(count)} to your challenge`, { address: k.PackGifts!, abi: packGiftsAbi, functionName: 'holdWithToken', args: [k.TestUSDC, id, 0, BigInt(count)] });
      } else {
        if (!eth) return;
        rc = await tx.run(`Attach ${packs(count)} to your challenge`, { address: k.PackGifts!, abi: packGiftsAbi, functionName: 'holdWithEth', args: [id, 0, BigInt(count)], value: eth });
      }
      if (rc) { await client!.attachGift(c.code); reads.refetch(); onChange(); }
    } catch (e) { setErr(friendlyError(e)); }
  };

  if (!open) {
    return <button className="pass-link small" onClick={() => setOpen(true)}>🎁 Attach a pack for your friend</button>;
  }
  return (
    <div className="gift-attach">
      <b>🎁 A gift for whoever plays this</b>
      <p className="muted small">Set 1 packs, delivered to them when the match ends. If nobody plays, you can take it back after three days (Profile → Invites).</p>
      <div className="ga-row">
        <div className="qty" role="group" aria-label="Packs to attach">
          <button className="btn" onClick={() => setCount((n) => Math.max(1, n - 1))} disabled={count <= 1} aria-label="Fewer">−</button>
          <span><b>{count}</b> pack{count > 1 ? 's' : ''}</span>
          <button className="btn" onClick={() => setCount((n) => Math.min(3, n + 1))} disabled={count >= 3} aria-label="More">+</button>
        </div>
        <button className="btn btn-primary" disabled={tx.busy || !usdc || bal < (usdc ?? 0n)} onClick={() => pay(true)}>
          Attach for {usdc ? formatUnits(usdc, 6) : '…'} tUSDC
        </button>
        <button className="btn" disabled={tx.busy || !eth} onClick={() => pay(false)}>or {eth ? formatEther(eth) : '…'} ETH</button>
      </div>
      {err && <div className="alert err">{err}</div>}
    </div>
  );
}

/** A challenge's gift, in words: for the friend ("yours after the match") or the challenger ("attached"). */
export function GiftNote({ g, mine = false }: { g: ChallengeGiftView; mine?: boolean }) {
  const what = packs(g.count);
  const text = g.state === 'delivered' ? (mine ? `🎁 ${what} delivered to ${shortAddr(g.to ?? '')}.` : `🎁 ${what} delivered: open ${g.count === 1 ? 'it' : 'them'} in your Collection.`)
    : g.state === 'due' ? `🎁 Delivering ${what}${mine && g.to ? ` to ${shortAddr(g.to)}` : ''}…`
    : g.state === 'refunded' ? `🎁 The ${what} went back to ${mine ? 'you' : 'the challenger'}.`
    : g.state === 'failed' ? `🎁 Delivering the ${what} failed; ${mine ? 'you can take it back from Profile → Invites after three days' : 'the challenger can take it back'}.`
    : mine ? `🎁 ${what} attached: delivered to whoever plays this, when the match ends.`
    : `🎁 ${shortAddr(String(g.from))} attached ${what} for you: yours when the match ends.`;
  return <div className={`gift-note ${g.state}`} role="status">{text}</div>;
}
