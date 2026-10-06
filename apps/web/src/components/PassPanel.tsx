import type { PassRewardInfo, PassStatus } from '@forkfall/sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider.tsx';
import { timeLeft } from '../lib/format.ts';
import { useLiveTopic } from '../lib/live.ts';

/** Time left in a season: days while there are more than two, then hours and minutes. */
export const seasonLeft = (ms: number) => (ms > 2 * 86_400_000 ? `${Math.floor(ms / 86_400_000)} days` : timeLeft(ms));

/** The signed-in player's season pass: refetched with quests (same referee notice), else every 30 s. */
export function usePass() {
  const { client, me } = useAuth();
  const qc = useQueryClient();
  const key = ['pass', me?.address];
  const up = useLiveTopic(client ? 'me' : null, (e) => {
    if (e.kind === 'quests' || e.kind === 'reconnect') qc.invalidateQueries({ queryKey: key }, { cancelRefetch: false });
  });
  return useQuery({
    queryKey: key,
    queryFn: () => client!.pass(),
    enabled: !!client,
    refetchInterval: up ? 120_000 : 30_000,
    retry: false,
  });
}

/** One reward in words: "1 pack", "50 Scrap", "Card back". */
export function rewardText(r?: PassRewardInfo): string {
  if (!r) return '';
  const parts: string[] = [];
  if (r.packs) parts.push(`${r.packs} pack${r.packs > 1 ? 's' : ''}`);
  if (r.scrap) parts.push(`${r.scrap} Scrap`);
  if (r.cosmetic) parts.push(r.cosmetic === 'title' ? 'Season title' : r.cosmetic === 'cardBack' ? 'Card back' : 'Animated badge');
  return parts.join(' + ');
}

export const rewardIcon = (r?: PassRewardInfo) => (!r ? '' : r.packs ? '🎁' : r.cosmetic ? '✦' : '⚙');

/** Progress inside the current tier (0–1) and XP still needed for the next one. */
export function tierProgress(s: PassStatus) {
  if (s.tier >= s.tiers.length) return { frac: 1, need: 0 };
  const into = s.xp - s.tier * s.xpPerTier;
  return { frac: into / s.xpPerTier, need: s.xpPerTier - into };
}

/** Compact season pass summary for Home, Play and the match result: tier, XP bar and the next rewards. */
export function PassPanel({ compact = false }: { compact?: boolean }) {
  const q = usePass();
  if (q.isError || !q.data) return null;
  const s = q.data;
  const { frac, need } = tierProgress(s);
  const next = s.tiers[s.tier]; // the tier being worked toward (undefined when maxed)
  return (
    <section className={`panel pass-panel ${compact ? 'compact' : ''}`} aria-label="Season pass">
      <div className="pass-head">
        <div>
          <span className="pass-kicker">Season {s.season} pass</span>
          <b className="pass-tier">Tier {s.tier}<span className="muted">/{s.tiers.length}</span></b>
        </div>
        {s.premium && <span className="pass-premium-tag">★ Premium</span>}
        {!compact && <Link className="btn btn-sm" to="/pass">View pass</Link>}
      </div>
      <div className="pass-bar" role="progressbar" aria-label="XP to the next tier" aria-valuemin={0} aria-valuemax={s.xpPerTier} aria-valuenow={Math.round(frac * s.xpPerTier)}>
        <i style={{ width: `${frac * 100}%` }} />
      </div>
      <div className="pass-foot small">
        {next ? (
          <span>
            {need} XP to tier {next.tier}: <b>{rewardText(next.free) || 'nothing on the free track'}</b>
            {next.premium && <span className="muted"> · premium {rewardText(next.premium)}</span>}
          </span>
        ) : <span>Pass complete. See you next season!</span>}
        <span className="muted">Ends in {seasonLeft(s.endsAt - Date.now())}</span>
      </div>
      {compact && <Link className="small" to="/pass">Open the season pass →</Link>}
    </section>
  );
}
