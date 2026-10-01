import { Link } from 'react-router-dom';
import { LOGO_MARK } from '../lib/art.ts';

export function Logo() {
  return (
    <Link to="/" className="logo" aria-label="Forkfall home">
      <img className="logo-mark" src={LOGO_MARK} alt="" />
      <span className="logo-word">FORKFALL</span>
    </Link>
  );
}
