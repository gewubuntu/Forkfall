import type { Address, Hex } from 'viem';
import { ApiError, type LobbyOptions, type Match } from './types.ts';

/** League charges: how often "not started" must be read, LEAGUE_RECHECK_MS apart, before giving up. */
const LEAGUE_CHARGE_CHECKS = 3;
const LEAGUE_RECHECK_MS = 20_000;
const LEAGUE_WATCH_MS = 30 * 60_000;

/** What league charging needs from the lobby around it. */
export interface LeagueHost {
  opts: LobbyOptions;
  now: () => number;
  save(m: Match): void;
  maybeStart(m: Match): void;
  changed(m: Match): void;
}

/** Agent League entry fees: who may enter, charging both fees on-chain when a match starts, and refunds. */
export class LeagueCharges {
  private inFlight = new Set<Hex>();

  constructor(private host: LeagueHost) {}

  private get recheckMs() { return this.host.opts.leagueRecheckMs ?? LEAGUE_RECHECK_MS; }

  /** League entry: a registered agent with enough prepaid balance for the entry fee (402 = deposit first). */
  async entry(address: Address): Promise<Address> {
    const league = this.host.opts.league;
    if (!league) throw new ApiError(503, 'the Agent League is not available on this server (no AgentLeague contract)');
    const [operator, balance, fee] = await Promise.all([league.operatorOf(address), league.balanceOf(address), league.entryFee()]);
    if (/^0x0{40}$/i.test(operator)) throw new ApiError(403, 'the Agent League is for registered agents (ERC-8004 AgentRegistry)');
    if (balance < fee) {
      throw new ApiError(402, `league balance too low: deposit at least ${Number(fee - balance) / 1e6} tUSDC into AgentLeague (entry fee ${Number(fee) / 1e6} per match)`);
    }
    return operator;
  }

  /**
   * Charge both league entry fees. The outcome of a failed call isn't always known (an RPC error, or a receipt
   * that timed out while the transaction is still pending), so a failure is only final once the chain has said
   * "not started" a few times, some time apart. Until then the match stays `charging` and is re-checked from
   * `tick`. If it turns out started, it counts as charged; a match cancelled after a charge is refunded on-chain.
   */
  charge(m: Match) {
    const h = this.host;
    const ops = h.opts.league!;
    if (this.inFlight.has(m.id)) return;
    this.inFlight.add(m.id);
    (async () => {
      // A retry first asks the chain: the earlier attempt may have gone through.
      if ((m.league?.notStarted ?? 0) > 0 || m.league?.retryAt !== undefined) {
        if (await ops.started(m.id)) return { tx: m.league?.tx };
      }
      return { tx: await ops.start(m.id, m.players[0].address, m.players[1].address) };
    })().then(
      ({ tx }) => { m.league = { state: 'charged', tx }; h.save(m); h.maybeStart(m); },
      async (e) => {
        let started: boolean | null;
        try { started = await ops.started(m.id); } catch { started = null; }
        if (started) { m.league = { state: 'charged' }; h.save(m); h.maybeStart(m); return; }
        const notStarted = (m.league?.notStarted ?? 0) + (started === false ? 1 : 0);
        if (notStarted >= LEAGUE_CHARGE_CHECKS) {
          // Gave up, but a transaction still pending could land later: watch for it and refund if it does.
          const at = h.now() + this.recheckMs;
          m.league = { state: 'failed', error: (e as Error).message, retryAt: at, watchUntil: h.now() + LEAGUE_WATCH_MS };
          m.phase = 'cancelled'; h.changed(m);
          return;
        }
        m.league = { state: 'charging', error: (e as Error).message, notStarted, retryAt: h.now() + this.recheckMs };
        h.save(m);
      },
    ).finally(() => this.inFlight.delete(m.id));
  }

  /** A league match that won't be played after all: refund both entry fees if they were charged. */
  refund(m: Match) {
    const ops = this.host.opts.league;
    if (!ops || m.mode !== 'league') return;
    ops.started(m.id)
      .then((started) => (started ? ops.cancel(m.id) : null))
      .then((tx) => { if (tx) console.log(`league match ${m.id} cancelled on-chain, entry fees refunded (${tx})`); })
      .catch((e) => console.error(`could not refund league match ${m.id}: ${(e as Error).message}`));
  }

  /**
   * The clock's league checks for one match: retry a charge whose outcome is unknown, or keep watching a given-up
   * charge for a late landing (then refund). True if the match was handled here and the clock should skip it.
   */
  tick(m: Match, now: number): boolean {
    if (m.phase === 'reveal' && m.league?.state === 'charging' && m.league.retryAt !== undefined && now >= m.league.retryAt) {
      this.charge(m);
      return true;
    }
    if (m.league?.state === 'failed' && m.league.watchUntil !== undefined && m.league.retryAt !== undefined && now >= m.league.retryAt) {
      const l = m.league;
      if (now > l.watchUntil!) { l.watchUntil = undefined; return true; }
      l.retryAt = now + this.recheckMs;
      this.host.opts.league?.started(m.id).then((started) => {
        if (!started) return;
        l.watchUntil = undefined;
        this.refund(m); // the charge landed after we gave up: give both fees back
      }, () => { /* ask again next time */ });
      return true;
    }
    return false;
  }
}
