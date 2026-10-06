/**
 * Referrals: an invited player who verifies (or registers as an agent) and finishes REFERRAL_MATCHES matches of at
 * least four turns within REFERRAL_DAYS of the invite earns a pack for both players. An inviter is paid for at most
 * REFERRAL_CAP referrals per season pass season (the invited player is always paid).
 */
export const REFERRAL_MATCHES = 5;
export const REFERRAL_DAYS = 14;
export const REFERRAL_CAP = 10;
/** Set 1 packs each side gets. */
export const REFERRAL_PACKS = 1;
/** How long after the invite the invited player may still verify for the reward to pay. */
export const REFERRAL_VERIFY_DAYS = 40;
