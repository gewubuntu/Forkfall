import { packGiftsAbi, type InvitesStatus, type QuestPayoutStatus, type ReferralView } from '@forkfall/sdk';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import type { Hex } from 'viem';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useTx } from '../chain/Tx.tsx';
import { useHub } from '../chain/useHub.ts';
import { avatarSvg } from '../lib/art.ts';
import { shortAddr, timeLeft } from '../lib/format.ts';
import { inviteLink } from '../lib/invite.ts';

/** Invite friends: your link, who you brought in and how far each is, and pack gifts nobody played for. */
export function InvitesCard() {
  const { client, me } = useAuth();
  const q = useQuery({ queryKey: ['invites', me?.address], queryFn: () => client!.invites(), enabled: !!client, refetchInterval: 30_000, retry: false });
  const [copied, setCopied] = useState(false);
  if (!me || q.isError) return null;
  const s = q.data;
  const link = inviteLink(me.address);
  const copy = async () => { await navigator.clipboard.writeText(link).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const share = () => navigator.share?.({ title: 'Forkfall', text: 'Play Forkfall with me: we both get a free pack.', url: link }).catch(() => {});

  return (
    <section className="panel invites-card" aria-labelledby="inv-h">
      <div className="inv-head">
        <h2 id="inv-h">Invite friends</h2>
        {s && <span className="muted small">Paid this season: <b>{s.paidThisSeason}/{s.cap}</b></span>}
      </div>
      <p className="muted small">
        When a friend signs in through your link (or accepts one of your challenges) for the first time, verifies as
        human or registers an agent, and finishes {s?.matchesGoal ?? 5} matches within {s?.days ?? 14} days, you both
        get a free Set 1 pack. Up to {s?.cap ?? 10} paid referrals per season.
      </p>
      <div className="cw-link">
        <input readOnly value={link} aria-label="Your invite link" onFocus={(e) => e.currentTarget.select()} />
        <button className="btn" onClick={copy}>{copied ? '✓ Copied' : 'Copy link'}</button>
        {'share' in navigator && <button className="btn btn-ghost" onClick={share}>Share</button>}
      </div>

      {s?.invitedBy && (
        <div className="inv-by">
          <span className="small muted">You were invited by</span>
          <Referral r={s.invitedBy} who={s.invitedBy.inviter} side="invited" />
        </div>
      )}

      {s && s.invited.length > 0 && (
        <ul className="inv-list" aria-label="Friends you invited">
          {s.invited.map((r) => <li key={r.invited}><Referral r={r} who={r.invited} side="inviter" /></li>)}
        </ul>
      )}
      {s && s.invited.length === 0 && <p className="muted small">Nobody joined through your link yet.</p>}

      {s && s.gifts.length > 0 && <HeldGifts gifts={s.gifts} onDone={() => q.refetch()} />}
    </section>
  );
}

function Referral({ r, who, side }: { r: ReferralView; who: string; side: 'inviter' | 'invited' }) {
  const left = r.deadline - Date.now();
  const status = r.state === 'playing' ? `${r.matches}/${r.goal} matches · ${left > 0 ? `${timeLeft(left)} left` : 'time is up'}`
    : r.state === 'verifying' ? (side === 'invited' ? 'Matches done: verify on this page to unlock the packs' : 'Matches done: waiting for them to verify')
    : r.state === 'expired' ? 'Expired'
    : side === 'inviter' && r.capped ? 'Joined (over this season’s cap: their pack only)' : 'Joined';
  return (
    <div className="inv-row">
      <img className="avatar sm" src={avatarSvg(who)} alt="" />
      <div className="inv-main">
        <b className="mono">{shortAddr(who)}</b>
        <span className="small muted">{r.via === 'challenge' ? 'via a challenge · ' : ''}{status}</span>
        {r.state === 'playing' && <span className="inv-bar" role="progressbar" aria-label="Matches toward the referral" aria-valuemin={0} aria-valuemax={r.goal} aria-valuenow={r.matches}><i style={{ width: `${(r.matches / r.goal) * 100}%` }} /></span>}
      </div>
      <PackTag p={r.payout} />
    </div>
  );
}

function PackTag({ p }: { p?: QuestPayoutStatus }) {
  if (!p) return null;
  if (p.state === 'paid') return <span className="q-tag ok" title={p.tx}>🎁 Pack sent</span>;
  if (p.state === 'offchain') return <span className="q-tag ok">🎁 Earned</span>;
  if (p.state === 'held') return <span className="q-tag held" title="Verify as human above to receive it">🔒 Held</span>;
  if (p.state === 'failed') return <span className="q-tag err" title={p.error}>Failed</span>;
  return <span className="q-tag pending"><span className="spinner" /> Sending</span>;
}

/** Gifts you attached to challenges nobody played: take them back once the hold is over. */
function HeldGifts({ gifts, onDone }: { gifts: InvitesStatus['gifts']; onDone: () => void }) {
  const { contracts } = useHub();
  const tx = useTx();
  if (!contracts?.PackGifts) return null;
  const refund = async (id: Hex) => {
    const rc = await tx.run('Take back your pack gift', { address: contracts.PackGifts!, abi: packGiftsAbi, functionName: 'refund', args: [id] });
    if (rc) onDone();
  };
  return (
    <div className="inv-gifts">
      <h3 className="small">Pack gifts waiting on a challenge</h3>
      <ul>
        {gifts.map((g) => {
          const at = g.refundableAt ?? 0;
          return (
            <li key={g.code} className="inv-row">
              <span>🎁 {g.count ?? 1} pack{g.count === 1 ? '' : 's'} on <Link to={`/challenge/${g.code}`} className="mono">{g.code}</Link></span>
              {Date.now() >= at
                ? <button className="btn btn-sm" disabled={tx.busy || !g.giftId} onClick={() => refund(g.giftId as Hex)}>Take back</button>
                : <span className="small muted">Refundable in {timeLeft(at - Date.now())}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
