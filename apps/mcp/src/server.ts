/**
 * The Forkfall MCP tools, for any client: main.ts serves them over stdio, tests over an in-memory transport.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { card, PREDICTION_LABELS, PREDICTION_TIERS, RACES, type Action, type Race } from '@forkfall/engine';
import { viewGreedy, type ForkfallClient, type MatchSnapshot } from '@forkfall/sdk';
import type { Hex } from 'viem';

export const RULES = `Forkfall rules (testnet alpha):
- 1v1. Drain the opponent's Treasury from 25 to 0. ~10 turns, 45s per turn + 60s bank. 40 half-turn cap: higher Treasury wins.
- Gas: +1 max per turn up to 10, refills each turn. Draw 1 per turn. Board: 5 unit slots. Hand limit 10.
- Units can't attack the turn they're played unless Rush. Guard units must be attacked first.
- Races: Agents (Deploy tokens, Automate next-turn effects, Compute discounts, Firewall pings summons),
  Prophets (face-down predictions on the opponent's next turn; Odds tier 1-3 scales payoff; wrong = Backfire),
  Brokers (Hold: +1/+1 each turn a unit didn't attack; Dividend triggers; Portfolio drops Bonds on death),
  Degens (Swarm: +1 atk per other Swarm unit; Pump random stats; Rug sacrifices a unit for Treasury damage; Ape: -2 cost with a random downside).
- Cycle: Prophets > Agents > Degens > Brokers > Prophets (soft ~55/45).
Actions: {type:"play",uid,target?,condition?,ape?} | {type:"attack",attacker,target:uid|"treasury"} | {type:"endTurn"} | {type:"concede"}.
Always choose from legalActions returned by forkfall_state.`;

export function describeSnapshot(s: MatchSnapshot) {
  const v = s.view;
  if (!v) return { matchId: s.matchId, phase: s.phase, note: 'waiting for seed reveal' };
  const me = s.seat;
  const cardName = (id: number) => card(id).name;
  return {
    matchId: s.matchId,
    phase: s.phase,
    turn: v.turn,
    yourSeat: me,
    yourTurn: s.phase === 'active' && v.active === me,
    winner: v.winner,
    endReason: v.endReason,
    clock: s.clock,
    players: v.players.map((p, i) => ({
      seat: i,
      race: p.race,
      agent: s.players[i].agent,
      treasury: p.treasury,
      gas: `${p.gas}/${p.maxGas}`,
      deck: p.deckCount,
      hand: p.handCount,
      board: p.board.map((u) => ({ uid: u.uid, card: cardName(u.cardId), attack: u.attack, health: u.health, keywords: u.keywords })),
      assets: p.assets.map((a) => cardName(a.cardId)),
      predictions: p.predictions.map((x) => ('hidden' in x ? 'face-down' : `${cardName(x.cardId)}: ${x.condition}`)),
    })),
    yourHand: v.hand.map((h) => ({ uid: h.uid, card: cardName(h.cardId), cost: card(h.cardId).cost, type: card(h.cardId).type, text: card(h.cardId).text })),
    legalActions: s.legalActions,
    predictionConditions: Object.fromEntries(Object.entries(PREDICTION_LABELS).map(([k, l]) => [k, `${l} (tier ${PREDICTION_TIERS[k as keyof typeof PREDICTION_TIERS]})`])),
  };
}

const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const raceSchema = z.enum(RACES as [Race, ...Race[]]);

export function createForkfallMcp(client: ForkfallClient): McpServer {
  let connected: Promise<unknown> | null = null;
  const ensure = () => (connected ??= client.connect({ agent: true }));
  const server = new McpServer({ name: 'forkfall', version: '0.1.0' });


  server.registerTool(
    'forkfall_league',
    { description: 'Agent League: current week, entry fee, pot split, standings and your prepaid balance (fund it with `pnpm league:deposit`). Amounts are tUSDC base units (6 decimals).' },
    async () => text(await client.league(client.address)),
  );

  server.registerTool(
    'forkfall_quests',
    {
      description: 'Today\'s daily quests (three, reset 00:00 UTC) with progress and Scrap rewards, the first-win bonus and free-pack progress. Rewards are paid on-chain automatically. Pass `reroll` (a quest slot 0-2) to swap one unfinished quest, once a day.',
      inputSchema: { reroll: z.number().int().min(0).max(2).optional() },
    },
    async ({ reroll }) => {
      await ensure();
      return text(reroll === undefined ? await client.quests() : await client.rerollQuest(reroll));
    },
  );

  server.registerTool(
    'forkfall_challenge',
    {
      description: 'Friend challenges (casual). `create` makes a challenge link (share https://<web>/challenge/<code>; `to` limits it to one address); poll with `status` until it has a matchId, then play it like any match. `accept` joins someone\'s challenge by code and returns the matchId. `list` shows yours and the ones addressed to you; `cancel` cancels yours or declines one sent to you.',
      inputSchema: {
        action: z.enum(['create', 'accept', 'status', 'list', 'cancel']),
        race: raceSchema.optional(),
        code: z.string().optional(),
        to: z.string().optional(),
      },
    },
    async ({ action, race, code, to }) => {
      await ensure();
      if (action === 'list') return text(await client.challenges());
      if (action === 'create') {
        if (!race) throw new Error('race is required to create a challenge');
        return text(await client.createChallenge({ race, to: to as Hex | undefined }));
      }
      if (!code) throw new Error('code is required');
      if (action === 'status') {
        const c = await client.challenge(code);
        if (c.matchId) await client.reveal(c.matchId).catch(() => {});
        return text(c);
      }
      if (action === 'cancel') return text(await client.cancelChallenge(code));
      if (!race) throw new Error('race is required to accept a challenge');
      const matchId = await client.acceptChallenge(code, { race });
      await client.reveal(matchId);
      return text({ matchId });
    },
  );

  server.registerTool('forkfall_rules', { description: 'Rules summary, races and action format.' }, async () => text(RULES));

  server.registerTool('forkfall_whoami', { description: 'Agent wallet address and server config (chain, season, EIP-712 domain).' }, async () => {
    const cfg = await ensure();
    return text({ address: client.address, config: cfg });
  });

  server.registerTool(
    'forkfall_practice',
    { description: 'Start a casual match against the house bot. Returns matchId.', inputSchema: { race: raceSchema, botRace: raceSchema.optional() } },
    async ({ race, botRace }) => {
      await ensure();
      const matchId = await client.practice({ race, botRace });
      await client.reveal(matchId);
      return text({ matchId });
    },
  );

  server.registerTool(
    'forkfall_queue',
    {
      description: 'Queue for casual or ranked play against humans/agents, or the Agent League (agents only, 0.50 tUSDC entry per match from your prepaid league balance; weekly pot paid to the best agents\' operators). Ranked and league need a deckId registered in DeckRegistry, and pair close ratings first (the window widens until anyone after a minute). Poll again with the same call until matched.',
      inputSchema: { mode: z.enum(['casual', 'ranked', 'league']), race: raceSchema, deckId: z.string().optional() },
    },
    async ({ mode, race, deckId }) => {
      await ensure();
      const status = await client.queueStatus();
      const r = status.status === 'idle' ? await client.queue({ mode, race, deckId: deckId as Hex | undefined }) : status;
      if (r.matchId) await client.reveal(r.matchId).catch(() => {});
      return text(r);
    },
  );

  server.registerTool(
    'forkfall_state',
    { description: 'Your redacted view of a match, including legalActions when it is your turn.', inputSchema: { matchId: z.string() } },
    async ({ matchId }) => {
      await ensure();
      const s = await client.state(matchId as Hex);
      if (s.phase === 'ended') await client.signResult(matchId as Hex).catch(() => {});
      return text(describeSnapshot(s));
    },
  );

  server.registerTool(
    'forkfall_move',
    {
      description: 'Sign (EIP-712) and submit one action. Pass an action object taken from legalActions.',
      inputSchema: { matchId: z.string(), action: z.record(z.string(), z.any()) },
    },
    async ({ matchId, action }) => {
      await ensure();
      const snap = await client.state(matchId as Hex);
      const next = await client.move(matchId as Hex, snap, action as Action);
      // A move that ends the match: sign the result now, as forkfall_state does, so it can settle.
      if (next.phase === 'ended') await client.signResult(matchId as Hex).catch(() => {});
      return text(describeSnapshot(next));
    },
  );

  server.registerTool(
    'forkfall_suggest',
    { description: "Heuristic suggestion from the reference greedy policy (uses only your view).", inputSchema: { matchId: z.string() } },
    async ({ matchId }) => {
      await ensure();
      const s = await client.state(matchId as Hex);
      if (!s.legalActions.length) return text('Not your turn.');
      return text(viewGreedy(s));
    },
  );

  server.registerTool(
    'forkfall_settlement',
    { description: 'Settlement JSON for on-chain submission via Foundry (Play.s.sol settle).', inputSchema: { matchId: z.string() } },
    async ({ matchId }) => {
      await ensure();
      await client.signResult(matchId as Hex).catch(() => {});
      return text(await client.settlement(matchId as Hex));
    },
  );

  return server;
}
