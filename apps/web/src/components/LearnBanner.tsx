import { Link } from 'react-router';
import { useMyCosmetics } from '../lib/cosmetics.ts';

/** "New here?" nudge to the tutorial, until you've finished it. */
export function LearnBanner() {
  const { tutorial, loading } = useMyCosmetics();
  if (tutorial || loading) return null;
  return (
    <Link className="learn-banner" to="/learn">
      <span className="lb-ico" aria-hidden>🎓</span>
      <span><b>New here? Learn to play in 3 minutes.</b> <span className="muted">A guided match against a gentle bot. Finish it to unlock the Graduate title.</span></span>
      <span className="lb-go" aria-hidden>→</span>
    </Link>
  );
}
