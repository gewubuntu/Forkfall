import type { QuestPayoutStatus, QuestStatus } from '@forkfall/sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider.tsx';
import { friendlyError } from '../chain/errors.ts';
import { timeLeft } from '../lib/format.ts';
import { useLiveTopic } from '../lib/live.ts';

/** Today's quests for the signed-in player: refetched when the referee pushes a quest notice, else every 30s. */
export function useQuests() {
  const { client, me } = useAuth();
  const qc = useQueryClient();
  const key = ['quests', me?.address];
  const up = useLiveTopic(client ? 'me' : null, (e) => {
    if (e.kind === 'quests' || e.kind === 'reconnect') qc.invalidateQueries({ queryKey: key }, { cancelRefetch: false });
  });
  return useQuery({
    queryKey: key,
    queryFn: () => client!.quests(),
    enabled: !!client,
    refetchInterval: up ? 120_000 : 30_000,
    retry: false,
  });
}

function PayoutTag({ p, done }: { p?: QuestPayoutStatus; done: boolean }) {
  if (!done) return null;
  if (!p || p.state === 'offchain') return <span className="q-tag ok">✓ Done</span>;
  if (p.state === 'paid') return <span className="q-tag ok" title={p.tx}>✓ Paid</span>;
  if (p.state === 'held') return <Link className="q-tag held" to="/profile" title="Verify as human on your Profile to receive it">🔒 Held</Link>;
  if (p.state === 'failed') return <span className="q-tag err" title={p.error}>Payout failed</span>;
  return <span className="q-tag pending" title={p.error ?? 'Sending your reward on-chain'}><span className="spinner" /> Paying</span>;
}

/**
 * Daily quests: three a day with progress bars and their Scrap, one reroll, the first-win bonus and the free
 * pack goal. `compact` drops the header for the match result screen.
 */
export function QuestPanel({ compact = false }: { compact?: boolean }) {
  const { client, me } = useAuth();
  const qc = useQueryClient();
  const q = useQuests();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 60_000); return () => clearInterval(t); }, []);
  if (q.isError || !q.data) return null; // server without quests, or still loading
  const s: QuestStatus = q.data;

  const reroll = async (slot: number) => {
    setErr(null); setBusy(true);
    try { qc.setQueryData(['quests', me?.address], await client!.rerollQuest(slot)); } catch (e) { setErr(friendlyError(e)); } finally { setBusy(false); }
  };
  const packPct = Math.min(100, (s.pack.completed / s.pack.goal) * 100);
  const period = s.pack.periodDays === 7 ? 'this week' : `in ${s.pack.periodDays} days`;

  return (
    <section className={`panel quests ${compact ? 'compact' : ''}`} aria-labelledby={compact ? undefined : 'quests-h'} aria-label={compact ? 'Daily quests' : undefined}>
      {!compact && (
        <div className="quests-head">
          <h2 id="quests-h">Daily quests</h2>
          <span className="muted small">New quests in {timeLeft(s.resetsAt - Date.now())}</span>
        </div>
      )}
      {err && <div className="alert err">{err}</div>}
      <ul className="quest-list">
        {s.quests.map((x) => (
          <li key={x.slot} className={`quest ${x.done ? 'done' : ''}`}>
            <div className="q-top">
              <b>{x.text}</b>
              <span className="q-reward">+{x.scrap} Scrap</span>
            </div>
            <div className="q-bar" role="progressbar" aria-valuemin={0} aria-valuemax={x.goal} aria-valuenow={x.progress} aria-label={x.text}>
              <i style={{ width: `${(x.progress / x.goal) * 100}%` }} />
            </div>
            <div className="q-foot">
              <span className="muted small">{x.progress}/{x.goal}</span>
              <PayoutTag p={x.payout} done={x.done} />
              {!x.done && !compact && s.rerollsLeft > 0 && (
                <button className="q-reroll" onClick={() => reroll(x.slot)} disabled={busy} title="Swap for another quest (once a day)">🎲 Reroll</button>
              )}
            </div>
          </li>
        ))}
        <li className={`quest bonus ${s.firstWin.done ? 'done' : ''}`}>
          <div className="q-top"><b>First win of the day</b><span className="q-reward">+{s.firstWin.scrap} Scrap</span></div>
          <div className="q-foot"><span className="muted small">{s.firstWin.done ? 'Won today' : 'Win any match'}</span><PayoutTag p={s.firstWin.payout} done={s.firstWin.done} /></div>
        </li>
      </ul>
      <div className={`quest-pack ${s.pack.completed >= s.pack.goal ? 'done' : ''}`}>
        <div className="q-top">
          <b>🎁 Free pack</b>
          <span className="muted small">{Math.min(s.pack.completed, s.pack.goal)}/{s.pack.goal} quests {period}</span>
        </div>
        <div className="q-bar pack" role="progressbar" aria-valuemin={0} aria-valuemax={s.pack.goal} aria-valuenow={s.pack.completed} aria-label="Free pack progress">
          <i style={{ width: `${packPct}%` }} />
        </div>
        <div className="q-foot">
          <span className="muted small">
            {s.pack.completed >= s.pack.goal
              ? <>Earned! It’s waiting in your <Link to="/collection">Collection</Link>.</>
              : `Complete ${s.pack.goal} daily quests by ${new Date(s.pack.endsAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}.`}
          </span>
          <PayoutTag p={s.pack.payout} done={s.pack.completed >= s.pack.goal} />
        </div>
      </div>
      {s.eligible === false && (
        <p className="q-gate small">
          🔒 Quest rewards go to verified humans and registered agents. Your progress counts; earned rewards are held and paid
          as soon as you <Link to="/profile">verify on your Profile</Link> (within 40 days).
        </p>
      )}
      {!s.paysOnChain && <p className="muted small">This server tracks progress but doesn’t pay rewards (it runs off-chain).</p>}
    </section>
  );
}
