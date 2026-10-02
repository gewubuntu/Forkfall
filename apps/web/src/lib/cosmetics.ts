import { cosmetic, NO_COSMETICS, type Equipped } from '@forkfall/engine';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { useAuth } from '../auth/AuthProvider.tsx';

/** Finishing the tutorial is remembered in the browser (it works without a wallet) and synced once you sign in. */
const TUTORIAL_KEY = 'ff.tutorial.done';

export function tutorialDoneLocally(): boolean {
  try { return localStorage.getItem(TUTORIAL_KEY) === '1'; } catch { return false; }
}

export function markTutorialDone() {
  try { localStorage.setItem(TUTORIAL_KEY, '1'); } catch { /* private mode: the server copy still counts */ }
  window.dispatchEvent(new Event('ff-tutorial-done'));
}

/** Emblems for titles and badges, per set. */
export const SET_EMBLEM: Record<string, string> = {
  agents: '🤖', prophets: '🔮', brokers: '📈', degens: '🎲', neutral: '⛓', poncho: '🌮', graduate: '🎓',
};
export const emblem = (id: string) => SET_EMBLEM[id.split(':')[1]] ?? '★';

/** CSS class for a card back cosmetic (`back:poncho` → `cb-poncho`); none = the default back. */
export const backClass = (id: string | null | undefined) => (id && cosmetic(id)?.kind === 'cardBack' ? `cb-${id.slice(5)}` : '');

/** The signed-in player's profile (tutorial, equipped cosmetics, what's unlocked), with tutorial sync and equip. */
export function useMyCosmetics() {
  const { client, me } = useAuth();
  const qc = useQueryClient();
  const address = me?.address;
  const q = useQuery({
    queryKey: ['profile', address],
    queryFn: () => client!.profile(address! as `0x${string}`),
    enabled: !!client && !!address,
    staleTime: 30_000,
  });

  // A tutorial finished before signing in (or on another tab) counts once you're signed in.
  useEffect(() => {
    if (!client || !q.data || q.data.profile.tutorial) return;
    const sync = () => {
      if (!tutorialDoneLocally()) return;
      client.completeTutorial().then(() => qc.invalidateQueries({ queryKey: ['profile'] })).catch(() => {});
    };
    sync();
    window.addEventListener('ff-tutorial-done', sync);
    return () => window.removeEventListener('ff-tutorial-done', sync);
  }, [client, q.data, qc]);

  const equip = useCallback(async (want: Partial<Equipped>) => {
    await client!.equip(want);
    await qc.invalidateQueries({ queryKey: ['profile'] });
  }, [client, qc]);

  const profile = q.data?.profile;
  return {
    loading: q.isLoading,
    error: q.error,
    equipped: profile ? { title: profile.title, cardBack: profile.cardBack, badge: profile.badge } : NO_COSMETICS,
    tutorial: profile?.tutorial ?? tutorialDoneLocally(),
    unlocked: new Set(q.data?.unlocked ?? []),
    equip,
  };
}
