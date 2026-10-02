import { card } from '@forkfall/engine';
import { packSaleAbi } from '@forkfall/sdk';
import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { usePublicClient } from 'wagmi';
import { avatarSvg } from '../lib/art.ts';
import { shortAddr } from '../lib/format.ts';

const FOIL_OFFSET = 20_000;
const LOOKBACK = 9_000n; // blocks; public RPCs cap log ranges around 10k

interface Pull { packId: bigint; owner: Address; cardId: number; foil: boolean; legendary: boolean; at: number }

/**
 * "Recent big pulls": Legendaries and foils from PackOpened events, straight from the chain, newest first.
 * Other people's pulls are the best advert for packs.
 */
export function PullFeed({ packSale, chainId, me }: { packSale: Address; chainId: number; me?: string }) {
  const client = usePublicClient({ chainId: chainId as never });
  const q = useQuery({
    queryKey: ['pull-feed', packSale, chainId],
    enabled: !!client,
    refetchInterval: 15_000,
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      const logs = await client!.getContractEvents({ address: packSale, abi: packSaleAbi, eventName: 'PackOpened', fromBlock: head > LOOKBACK ? head - LOOKBACK : 0n, toBlock: head });
      const pulls: (Omit<Pull, 'at'> & { block: bigint })[] = [];
      for (const l of logs) {
        for (const raw of (l.args.cardIds ?? []).map(Number)) {
          const foil = raw >= FOIL_OFFSET, base = foil ? raw - FOIL_OFFSET : raw;
          const legendary = card(base).rarity === 'legendary';
          if (foil || legendary) pulls.push({ packId: l.args.packId!, owner: l.args.owner!, cardId: base, foil, legendary, block: l.blockNumber! });
        }
      }
      const recent = pulls.reverse().slice(0, 8);
      const times = new Map<bigint, number>();
      for (const b of new Set(recent.map((p) => p.block))) times.set(b, Number((await client!.getBlock({ blockNumber: b })).timestamp));
      return recent.map((p) => ({ ...p, at: times.get(p.block) ?? 0 }));
    },
  });
  const pulls: Pull[] = q.data ?? [];
  return (
    <div className="pull-feed">
      <h3>Recent big pulls</h3>
      {q.isLoading ? <p className="muted small">Reading the chain…</p>
        : pulls.length === 0 ? <p className="muted small">No Legendaries or foils pulled lately. Be the first.</p> : (
        <ul>
          {pulls.map((p, i) => (
            <li key={`${p.packId}-${i}`} className={p.legendary ? 'leg' : 'foil'}>
              <img className="avatar" src={avatarSvg(p.owner)} alt="" />
              <span>
                <b>{me && p.owner.toLowerCase() === me.toLowerCase() ? 'You' : shortAddr(p.owner)}</b> pulled{' '}
                <span className="pf-card">{p.foil ? '✦ Foil ' : ''}{p.legendary ? 'Legendary ' : ''}{card(p.cardId).name}</span>
              </span>
              <span className="muted small">{ago(p.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ago(t: number) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86_400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86_400)}d ago`;
}
