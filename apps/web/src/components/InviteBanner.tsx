import { avatarSvg } from '../lib/art.ts';
import { shortAddr } from '../lib/format.ts';
import { inviteTerms, pendingRef } from '../lib/invite.ts';

/** "A friend invited you": shown before sign-in to someone who came through an invite link. */
export function InviteBanner() {
  const ref = pendingRef();
  if (!ref) return null;
  return (
    <div className="invite-banner" role="note">
      <img className="avatar sm" src={avatarSvg(ref)} alt="" />
      <span><b>🎁 Invited by <span className="mono">{shortAddr(ref)}</span>.</b> {inviteTerms}</span>
    </div>
  );
}
