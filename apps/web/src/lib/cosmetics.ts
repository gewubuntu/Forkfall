import { cosmetic } from '@forkfall/engine';

// Pure helpers, no wallet or auth code: card backs and lesson progress are used by lesson pages too (lesson.html).
// The signed-in player's profile hook is in useMyCosmetics.ts.

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
export const emblem = (id: string) => {
  const key = id.split(':')[1];
  return key?.startsWith('season-') ? '🏆' : key?.includes('sealed') || key === 'unsealed' ? '🎴' : SET_EMBLEM[key] ?? '★';
};

/** CSS class for a card back cosmetic (`back:poncho` → `cb-poncho`); none = the default back. */
export const backClass = (id: string | null | undefined) => (id && cosmetic(id)?.kind === 'cardBack' ? `cb-${id.slice(5)}` : '');
