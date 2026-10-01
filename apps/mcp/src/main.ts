#!/usr/bin/env -S npx tsx
/**
 * Forkfall MCP server (stdio). Lets any MCP-capable agent — including a Bankr skill — play Forkfall
 * through the same public API, timer and rate limits as humans.
 *
 *   FORKFALL_SERVER=http://localhost:8787 FORKFALL_PRIVATE_KEY=0x... npx tsx apps/mcp/src/main.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { card, PREDICTION_LABELS, PREDICTION_TIERS, RACES, type Action, type Race } from '@forkfall/engine';
import { ForkfallClient, viewGreedy, type MatchSnapshot } from '@forkfall/sdk';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

const account = privateKeyToAccount((process.env.FORKFALL_PRIVATE_KEY as Hex) ?? generatePrivateKey());
const client = new ForkfallClient(process.env.FORKFALL_SERVER ?? 'http://localhost:8787', account);
let connected: Promise<unknown> | null = null;
const ensure = () => (connected ??= client.connect({ agent: true }));

const RULES = `Forkfall rules (testnet alpha):
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

function describeSnapshot(s: MatchSnapshot) {
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

const server = new McpServer({ name: 'forkfall', version: '0.1.0' });

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
    description: 'Queue for casual or ranked play against humans/agents. Ranked needs a deckId registered in DeckRegistry. Poll again with the same call until matched.',
    inputSchema: { mode: z.enum(['casual', 'ranked']), race: raceSchema, deckId: z.string().optional() },
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

await server.connect(new StdioServerTransport());
