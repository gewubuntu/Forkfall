import { matchCounts, passSeason, questDay, REFERRAL_CAP, REFERRAL_DAYS, REFERRAL_MATCHES, REFERRAL_PACKS, REFERRAL_VERIFY_DAYS } from '@forkfall/engine';
import type { ChallengeGiftView, InvitesStatus, ReferralView } from '@forkfall/sdk';
import { join } from 'node:path';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import type { GiftDeliverer } from './chain.ts';
import type { FinishedMatch, Quests } from './quests.ts';
import { readJsonOrSetAside, writeFileAtomic } from './state.ts';

/** Where referrals and challenge gifts are kept: apps/server/data/invites/<chainId>.json. */
export const invitesFile = (root: string, chainId: number) => join(root, 'apps/server/data/invites', `${chainId}.json`);

const DAY_MS = 86_400_000;
/** How often a qualified referral re-checks whether the invited player has verified (and after a failed read). */
const VERIFY_RECHECK_MS = 5 * 60_000;
/** Chain reads (eligibility, gift state) per tick, so the loop's RPC load stays bounded. */
const READS_PER_TICK = 20;
const RETRY_MAX_MS = 60 * 60_000;
const MAX_ATTEMPTS = 20;
const SEEN_LIMIT = 5000;
/** Gifts nobody can still act on are forgotten after this (the chain keeps the record). */
const GIFT_KEEP_MS = 7 * DAY_MS;
/** Held gifts stay listed this long, so the Take back button outlives the hold by a wide margin. */
const HELD_KEEP_MS = 30 * DAY_MS;
/** A gift whose challenge was played while its payment was still in flight waits this long before counting as unpaid. */
const UNPAID_GRACE_MS = 10 * 60_000;
/** Settled invites (paid or expired) are forgotten after this: past verification (40 d) plus the payout view (40 d). */
const INVITE_KEEP_MS = 80 * DAY_MS;
/** A challenger's own request re-reads an unpaid gift on-chain at most this often (the loop paces itself). */
const CONFIRM_MIN_MS = 10_000;
/** The invite store's bound: sign-ins are free, so a sign-up flood must not grow the file without limit. */
const MAX_INVITES = 10_000;

interface Invite {
  inviter: string;
  invited: string;
  at: number;
  via: 'link' | 'challenge';
  /** Qualifying matches (at least four turns) the invited player finished within REFERRAL_DAYS. */
  matches: number;
  /** playing: counting matches · verifying: enough matches, waiting for the invited player to verify · paid · expired. */
  state: 'playing' | 'verifying' | 'paid' | 'expired';
  /** Season pass season the referral paid in (counts against the inviter's cap). */
  season?: number;
  /** The inviter was over the season's cap: only the invited player was paid. */
  capped?: boolean;
  checkAt?: number;
}

interface Gift {
  code: string;
  giftId: Hex;
  from: string;
  createdAt: number;
  /** unpaid: id issued, nothing held on-chain yet · held · due: the match ended, deliver to `to` · delivered ·
   *  refunded (by its buyer, after the hold) · none: never paid · failed: delivery kept failing. */
  state: 'unpaid' | 'held' | 'due' | 'delivered' | 'refunded' | 'none' | 'failed';
  count?: number;
  kind?: number;
  refundableAt?: number;
  /** The friend who played the challenge, once its match ended (and when, for the unpaid grace window). */
  to?: string;
  dueAt?: number;
  /** When the chain was last read for this gift on the challenger's own request (bounds those reads). */
  checkedAt?: number;
  tx?: Hex;
  error?: string;
  attempts: number;
  nextAt: number;
}

interface Store { invites: Record<string, Invite>; gifts: Record<string, Gift>; seen: string[] }

export interface InvitesOptions {
  file?: string;
  chainId: number;
  /** Pays referral packs on the quest payout loop (same eligibility gate, retries and budget). */
  quests: Quests;
  /** Whether a wallet has ever played here: only wallets that haven't can be invited. */
  hasPlayed: (address: Address) => boolean;
  /** Who counts as verified for a referral: humans and registered agents (not banned). Omit: everyone. */
  eligible?: (address: Address) => Promise<boolean>;
  /** PackGifts on this deployment (absent: challenge gifts aren't offered). */
  gifts?: GiftDeliverer | null;
  /** Bound on stored invites (tests only; the default suits a referee). */
  maxInvites?: number;
  now?: () => number;
}

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Referrals and pack gifts held for friend challenges. A wallet that has never played can be invited once, by an
 * invite link or by accepting a challenge; when it finishes enough matches and verifies, both players get a pack
 * through QuestRewards. A gift held for a challenge (PackGifts) is delivered to whoever plays the challenge.
 */
export class Invites {
  private data: Store;
  readonly setAside: string | null;
  private busy = false;
  private now: () => number;

  constructor(private opts: InvitesOptions) {
    const empty = (): Store => ({ invites: {}, gifts: {}, seen: [] });
    const valid = (x: Record<string, unknown>) =>
      typeof x.invites === 'object' && x.invites !== null && typeof x.gifts === 'object' && x.gifts !== null && Array.isArray(x.seen);
    ({ data: this.data, setAside: this.setAside } = opts.file ? readJsonOrSetAside(opts.file, empty, { valid }) : { data: empty(), setAside: null });
    this.now = opts.now ?? Date.now;
  }

  get offersGifts() { return !!this.opts.gifts; }

  // ─── Referrals ───────────────────────────────────────────────
  /**
   * Record that `inviter` invited `invited`. Only a wallet that has never played and was never invited counts, and
   * nobody invites themselves. Returns whether the invite was recorded. `wasNew`: the caller already checked
   * `hasPlayed` before an action that itself created a match (accepting a challenge), so it isn't re-checked here.
   */
  invite(invited: string, inviter: string, via: Invite['via'], wasNew = false): boolean {
    if (!/^0x[0-9a-fA-F]{40}$/.test(invited) || !/^0x[0-9a-fA-F]{40}$/.test(inviter)) return false;
    const a = invited.toLowerCase();
    const by = inviter.toLowerCase();
    if (a === by || this.data.invites[a] || (!wasNew && this.opts.hasPlayed(a as Address))) return false;
    if (Object.keys(this.data.invites).length >= (this.opts.maxInvites ?? MAX_INVITES)) {
      // A sign-up flood filled the store: make room from invites past their deadline, else count no more.
      const overdue = Object.values(this.data.invites)
        .filter((i) => i.state === 'expired' || (i.state === 'playing' && this.now() > i.at + REFERRAL_DAYS * DAY_MS))
        .sort((x, y) => x.at - y.at);
      for (const i of overdue.slice(0, 1000)) delete this.data.invites[i.invited];
      if (Object.keys(this.data.invites).length >= (this.opts.maxInvites ?? MAX_INVITES)) return false;
    }
    this.data.invites[a] = { inviter: by, invited: a, at: this.now(), via, matches: 0, state: 'playing' };
    this.save();
    return true;
  }

  /** Count a finished match: referral progress, and the challenge's held gift falls due. Idempotent per match. */
  record(m: FinishedMatch) {
    if (this.data.seen.includes(m.id)) return;
    this.data.seen.push(m.id);
    if (this.data.seen.length > SEEN_LIMIT) this.data.seen.splice(0, this.data.seen.length - SEEN_LIMIT);
    m.players.forEach((pl, seat) => {
      // Only matches against people or agents move a referral: practice against a house bot can't farm it.
      if (pl.bot || m.players[1 - seat]?.bot) return;
      const inv = this.data.invites[pl.address.toLowerCase()];
      if (!inv || inv.state !== 'playing' || !matchCounts(m) || m.endedAt < inv.at || m.endedAt > inv.at + REFERRAL_DAYS * DAY_MS) return;
      inv.matches++;
      if (inv.matches >= REFERRAL_MATCHES) { inv.state = 'verifying'; inv.checkAt = 0; }
    });
    const g = m.challenge ? this.giftFor(m.challenge) : undefined;
    if (g && (g.state === 'held' || g.state === 'unpaid') && !g.to) {
      const friend = m.players.find((p) => !same(p.address, g.from) && !p.bot);
      if (friend) { g.to = friend.address.toLowerCase(); g.dueAt = this.now(); g.nextAt = 0; if (g.state === 'held') g.state = 'due'; }
    }
    this.save();
  }

  /** Your referrals (as inviter) and the one that brought you (as invited). */
  status(address: string): InvitesStatus {
    const a = address.toLowerCase();
    const season = passSeason(questDay(this.now())).season;
    const mine = Object.values(this.data.invites).filter((i) => i.inviter === a).sort((x, y) => y.at - x.at);
    const by = this.data.invites[a];
    const view = (i: Invite, side: 'inviter' | 'invited'): ReferralView => ({
      inviter: i.inviter, invited: i.invited, at: i.at, via: i.via, matches: i.matches, goal: REFERRAL_MATCHES,
      deadline: i.at + REFERRAL_DAYS * DAY_MS, state: i.state, capped: !!i.capped,
      payout: this.opts.quests.payoutState(claimId(this.opts.chainId, i, side)),
    });
    return {
      invited: mine.map((i) => view(i, 'inviter')),
      invitedBy: by ? view(by, 'invited') : null,
      gifts: Object.values(this.data.gifts).filter((g) => g.from === a && (g.state === 'held' || g.state === 'failed'))
        .sort((x, y) => y.createdAt - x.createdAt).map((g) => ({ code: g.code, ...this.giftView(g.code, a)! })),
      paidThisSeason: mine.filter((i) => i.state === 'paid' && i.season === season && !i.capped).length,
      cap: REFERRAL_CAP, matchesGoal: REFERRAL_MATCHES, days: REFERRAL_DAYS, packs: REFERRAL_PACKS,
    };
  }

  // ─── Challenge gifts ─────────────────────────────────────────
  /**
   * The gift id for a challenge's pack gift (issued once, to its challenger), confirmed against PackGifts when it's
   * been paid. Only gifts paid by the challenger count: anyone else holding a gift under the id is ignored.
   */
  async attachGift(code: string, challenger: string): Promise<ChallengeGiftView> {
    if (!this.opts.gifts) throw new Error('pack gifts are not enabled on this server');
    let g = this.giftFor(code);
    if (g && !same(g.from, challenger)) throw new Error('only the challenger can attach a gift');
    // A dead record the challenger never paid (someone front-ran the id, or it settled unpaid) blocks nothing:
    // while the challenge hasn't been played, start over under a fresh id (keeping the read pacing below).
    let checkedAt = g?.checkedAt;
    if (g && g.state === 'none' && !g.to) { delete this.data.gifts[g.giftId]; g = undefined; }
    if (!g) {
      const giftId = keccak256(toHex(`forkfall-gift:${this.opts.chainId}:${code}:${crypto.randomUUID()}`));
      g = { code, giftId, from: challenger.toLowerCase(), createdAt: this.now(), state: 'unpaid', attempts: 0, nextAt: 0, ...(checkedAt ? { checkedAt } : {}) };
      this.data.gifts[giftId] = g;
      this.save();
    }
    // One chain read per request would let a challenger drive the RPC: pace their own confirms like the pass sync.
    if (g.state === 'unpaid' && this.now() - (g.checkedAt ?? 0) >= CONFIRM_MIN_MS) await this.confirm(g);
    return this.giftView(code, challenger)!;
  }

  /** What a viewer may see of a challenge's gift: everyone sees that one waits; only the challenger sees its id. */
  giftView(code: string, viewer: string | null): ChallengeGiftView | undefined {
    const g = this.giftFor(code);
    if (!g) return undefined;
    const mine = same(g.from, viewer);
    // A gift that was never paid ('unpaid', or 'none' once settled) is no gift: showing it would promise the
    // friend packs that are not coming. Only the challenger sees the record, to pay it or start over.
    if (!mine && (g.state === 'unpaid' || g.state === 'none')) return undefined;
    return {
      state: g.state, from: g.from, count: g.count ?? null, kind: g.kind ?? null, to: g.to ?? null, tx: g.tx ?? null,
      refundableAt: g.refundableAt ?? null, ...(mine ? { giftId: g.giftId } : {}),
    };
  }

  /** Read a gift's state on-chain and adopt it (only the challenger's own payment counts). */
  private async confirm(g: Gift): Promise<boolean> {
    g.checkedAt = this.now();
    try {
      const h = await this.opts.gifts!.read(g.giftId);
      if (h.state === 'none') return true;
      if (!same(h.from, g.from)) { g.state = 'none'; g.error = 'held by someone else'; this.save(); return true; }
      g.count = h.count; g.kind = h.kind; g.refundableAt = h.refundableAt;
      g.state = h.state === 'held' ? (g.to ? 'due' : 'held') : h.state;
      this.save();
      return true;
    } catch { return false; }
  }

  private giftFor(code: string): Gift | undefined {
    return Object.values(this.data.gifts).find((g) => g.code === code);
  }

  // ─── The loop ────────────────────────────────────────────────
  /** Expire, verify and pay referrals; deliver gifts whose challenge was played. Bounded chain reads per tick. */
  async tick(): Promise<{ paid: string[]; delivered: Gift[]; failed: Gift[] }> {
    const out = { paid: [] as string[], delivered: [] as Gift[], failed: [] as Gift[] };
    if (this.busy) return out;
    this.busy = true;
    let reads = 0;
    let changed = false;
    try {
      const now = this.now();
      for (const inv of Object.values(this.data.invites)) {
        if (inv.state === 'playing' && now > inv.at + REFERRAL_DAYS * DAY_MS) { inv.state = 'expired'; changed = true; continue; }
        if (inv.state !== 'verifying' || (inv.checkAt ?? 0) > now || reads >= READS_PER_TICK) continue;
        if (now > inv.at + REFERRAL_VERIFY_DAYS * DAY_MS) { inv.state = 'expired'; changed = true; continue; }
        reads++;
        let ok: boolean;
        try { ok = this.opts.eligible ? await this.opts.eligible(inv.invited as Address) : true; } catch { ok = false; }
        if (!ok) { inv.checkAt = now + VERIFY_RECHECK_MS; continue; }
        this.pay(inv);
        out.paid.push(inv.invited);
        changed = true;
      }
      for (const g of Object.values(this.data.gifts)) {
        if (!this.opts.gifts || g.nextAt > now || reads >= READS_PER_TICK) continue;
        if (g.state === 'unpaid' && g.to) {
          // Played before the payment was confirmed: keep reading through a grace window, in case the hold is
          // still in flight. Only a successful read that still shows nothing held settles it as never paid;
          // a failed read (the RPC being down) never writes a paid gift off.
          reads++;
          const read = await this.confirm(g);
          if (g.state === 'unpaid') {
            if (read && now > (g.dueAt ?? 0) + UNPAID_GRACE_MS) { g.state = 'none'; changed = true; }
            else { g.nextAt = now + 30_000; continue; }
          }
        }
        if (g.state === 'held' && now >= (g.refundableAt ?? Infinity)) {
          // Past the hold with nobody playing: adopt a refund the buyer may have taken on-chain.
          reads++;
          await this.confirm(g);
          g.nextAt = now + DAY_MS;
          changed = true;
        }
        if (g.state !== 'due' || !g.to) continue;
        reads++;
        try {
          g.tx = await this.opts.gifts.deliver(g.giftId, g.to as Address);
          g.state = 'delivered'; g.error = undefined; out.delivered.push(g);
        } catch (e) {
          const msg = (e as Error).message;
          if (/NotHeld/.test(msg)) { await this.confirm(g); if (g.state === 'due') g.state = 'failed'; }
          else {
            g.attempts++; g.error = msg; g.nextAt = now + Math.min(RETRY_MAX_MS, 30_000 * 2 ** g.attempts);
            if (g.attempts >= MAX_ATTEMPTS) g.state = 'failed';
          }
          out.failed.push(g);
        }
        changed = true;
      }
    } finally { this.busy = false; }
    if (changed) this.save();
    return out;
  }

  /** Both get their pack; the inviter only while under the season's cap. */
  private pay(inv: Invite) {
    const season = passSeason(questDay(this.now())).season;
    const paid = Object.values(this.data.invites).filter((i) => i.inviter === inv.inviter && i.state === 'paid' && i.season === season && !i.capped).length;
    inv.state = 'paid';
    inv.season = season;
    inv.capped = paid >= REFERRAL_CAP;
    const q = this.opts.quests;
    q.queueReward(inv.invited, 'referral', `referral-from-${inv.inviter}`, claimId(this.opts.chainId, inv, 'invited'), 0, REFERRAL_PACKS);
    if (!inv.capped) q.queueReward(inv.inviter, 'referral', `referral-${inv.invited}`, claimId(this.opts.chainId, inv, 'inviter'), 0, REFERRAL_PACKS);
  }

  private save() {
    this.prune();
    if (!this.opts.file) return;
    writeFileAtomic(this.opts.file, JSON.stringify(this.data));
  }

  /**
   * Forget settled gifts a week after they were made (by then their challenge link expired long ago). A gift still
   * due is kept, and one still refundable by its buyer (held, or failed to deliver) stays a month, so the Take back
   * button long outlives the three-day hold; after that, PackGifts itself still refunds the buyer. Settled invites
   * (paid or expired) go after 80 days; the chain and the payout records keep what matters.
   */
  private prune() {
    const now = this.now();
    for (const [id, g] of Object.entries(this.data.gifts)) {
      if (g.state === 'due') continue;
      if (g.createdAt < now - (g.state === 'held' || g.state === 'failed' ? HELD_KEEP_MS : GIFT_KEEP_MS)) delete this.data.gifts[id];
    }
    for (const [a, inv] of Object.entries(this.data.invites)) {
      if ((inv.state === 'paid' || inv.state === 'expired') && inv.at < now - INVITE_KEEP_MS) delete this.data.invites[a];
    }
  }
}

/** One claim id per (chain, inviter, invited, side): a retried or re-queued referral never pays twice. */
function claimId(chainId: number, i: { inviter: string; invited: string }, side: 'inviter' | 'invited'): Hex {
  return keccak256(toHex(`forkfall-referral:${chainId}:${i.inviter}:${i.invited}:${side}`));
}
