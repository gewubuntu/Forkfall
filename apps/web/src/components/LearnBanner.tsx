import { LESSONS } from '@forkfall/engine';
import { Link } from 'react-router';
import { useMyCosmetics } from '../lib/cosmetics.ts';

/** "New here?" nudge to the tutorial until you've finished it, then to the race lessons until those are done. */
export function LearnBanner({ races = false }: { races?: boolean }) {
  const { tutorial, lessons, loading } = useMyCosmetics();
  if (loading) return null;
  if (!tutorial) {
    return (
      <Link className="learn-banner" to="/learn/basics">
        <span className="lb-ico" aria-hidden>🎓</span>
        <span><b>New here? Learn to play in 3 minutes.</b> <span className="muted">A guided match against a gentle bot. Finish it to unlock the Graduate title.</span></span>
        <span className="lb-go" aria-hidden>→</span>
      </Link>
    );
  }
  const left = LESSONS.filter((l) => !lessons.includes(l.id));
  if (!races || !left.length) return null;
  return (
    <Link className="learn-banner small" to="/learn">
      <span className="lb-ico" aria-hidden>📜</span>
      <span><b>Race lessons: {LESSONS.length - left.length} of {LESSONS.length} done.</b> <span className="muted">Learn {left.map((l) => l.title.split(':')[0]).join(', ')} in a few minutes each. All four unlock the Scholar title.</span></span>
      <span className="lb-go" aria-hidden>→</span>
    </Link>
  );
}
