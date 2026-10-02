import { cosmetic, NO_COSMETICS, type Equipped } from '@forkfall/engine';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { useAuth } from '../auth/AuthProvider.tsx';

/** Finished lessons are remembered in the browser (they work without a wallet) and synced once you sign in. */
const LESSONS_KEY = 'ff.lessons.done';
/** Before race lessons, only the tutorial was tracked. */
const TUTORIAL_KEY = 'ff.tutorial.done';

export function lessonsDoneLocally(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(LESSONS_KEY) ?? '[]') as string[];
    return localStorage.getItem(TUTORIAL_KEY) === '1' && !list.includes('basics') ? ['basics', ...list] : list;
  } catch { return []; }
}

export function markLessonDone(id: string) {
  const list = lessonsDoneLocally();
  try { if (!list.includes(id)) localStorage.setItem(LESSONS_KEY, JSON.stringify([...list, id])); } catch { /* private mode: the server copy still counts */ }
  window.dispatchEvent(new Event('ff-lesson-done'));
}

/** Emblems for titles and badges, per set. */
export const SET_EMBLEM: Record<string, string> = {
  agents: '🤖', prophets: '🔮', brokers: '📈', degens: '🎲', neutral: '⛓', poncho: '🌮', graduate: '🎓', scholar: '📜',
};
export const emblem = (id: string) => SET_EMBLEM[id.split(':')[1]] ?? '★';

/** CSS class for a card back cosmetic (`back:poncho` → `cb-poncho`); none = the default back. */
export const backClass = (id: string | null | undefined) => (id && cosmetic(id)?.kind === 'cardBack' ? `cb-${id.slice(5)}` : '');

/** The signed-in player's profile (lessons, equipped cosmetics, what's unlocked), with lesson sync and equip. */
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

  // Lessons finished before signing in (or on another tab) count once you're signed in.
  useEffect(() => {
    if (!client || !q.data) return;
    const synced = q.data.profile.lessons ?? [];
    const sync = () => {
      const missing = lessonsDoneLocally().filter((l) => !synced.includes(l));
      if (!missing.length) return;
      Promise.all(missing.map((l) => client.completeTutorial(l)))
        .then(() => qc.invalidateQueries({ queryKey: ['profile'] })).catch(() => {});
    };
    sync();
    window.addEventListener('ff-lesson-done', sync);
    return () => window.removeEventListener('ff-lesson-done', sync);
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
    lessons: [...new Set([...(profile?.lessons ?? []), ...lessonsDoneLocally()])],
    tutorial: (profile?.tutorial ?? false) || lessonsDoneLocally().includes('basics'),
    unlocked: new Set(q.data?.unlocked ?? []),
    equip,
  };
}
