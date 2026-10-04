import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ForkfallClient, replayLog } from '@forkfall/sdk';
import type { AddressInfo } from 'node:net';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chain } from '../../server/src/chain.ts';
import { createApi } from '../../server/src/http.ts';
import { Lobby } from '../../server/src/lobby.ts';
import { createForkfallMcp } from '../src/server.ts';

// A real referee in-process, the MCP server on an in-memory transport, and an MCP client calling its tools:
// everything an MCP agent does, minus stdio.
const lobby = new Lobby({ chain: new Chain(null), house: privateKeyToAccount(generatePrivateKey()) });
const { server } = createApi(lobby, { ratePerSec: 10_000 });
let agent: ForkfallClient;
const mcp = new Client({ name: 'forkfall-test', version: '1.0.0' });

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  agent = new ForkfallClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, privateKeyToAccount(generatePrivateKey()));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createForkfallMcp(agent).connect(serverSide);
  await mcp.connect(clientSide);
});
afterAll(async () => { await mcp.close(); server.close(); });

/** Call a tool; returns its parsed JSON (or plain text) and whether it reported an error. */
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await mcp.callTool({ name, arguments: args }) as { content: { type: string; text: string }[]; isError?: boolean };
  const text = r.content[0]?.text ?? '';
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { json, text, isError: !!r.isError };
}

describe('Forkfall MCP server', () => {
  it('lists every tool, with input schemas where they take arguments', async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'forkfall_challenge', 'forkfall_league', 'forkfall_move', 'forkfall_practice', 'forkfall_quests', 'forkfall_queue',
      'forkfall_rules', 'forkfall_settlement', 'forkfall_state', 'forkfall_suggest', 'forkfall_whoami',
    ]);
    const move = tools.find((t) => t.name === 'forkfall_move')!;
    expect(move.inputSchema.required).toEqual(expect.arrayContaining(['matchId', 'action']));
    const practice = tools.find((t) => t.name === 'forkfall_practice')!;
    expect((practice.inputSchema.properties as any).race.enum).toEqual(['agents', 'prophets', 'brokers', 'degens']);
  });

  it('explains the rules and who it is playing as', async () => {
    expect((await call('forkfall_rules')).text).toMatch(/Treasury from 25 to 0/);
    const me = await call('forkfall_whoami');
    expect(me.json.address).toBe(agent.address);
    expect(me.json.config.chainId).toBe(31337);
  });

  it('plays a full practice match through the tools and returns a settlement that replays', async () => {
    const { json: started } = await call('forkfall_practice', { race: 'brokers', botRace: 'degens' });
    const matchId = started.matchId as Hex;
    expect(matchId).toMatch(/^0x[0-9a-f]{64}$/);

    let state = (await call('forkfall_state', { matchId })).json;
    let moves = 0;
    for (let i = 0; i < 2000 && state.phase !== 'ended'; i++) {
      if (state.yourTurn) {
        const suggestion = (await call('forkfall_suggest', { matchId })).json;
        expect(state.legalActions).toContainEqual(suggestion);
        const moved = await call('forkfall_move', { matchId, action: suggestion });
        expect(moved.isError).toBe(false);
        state = moved.json;
        moves++;
      } else {
        await lobby.stepBots();
        state = (await call('forkfall_state', { matchId })).json;
      }
    }
    expect(state.phase).toBe('ended');
    expect(moves).toBeGreaterThan(0);
    expect(['treasury', 'turnLimit']).toContain(state.endReason);

    // forkfall_state signs the result as soon as it sees the match ended, before anyone asks for a settlement.
    expect(lobby.get(matchId).players[state.yourSeat as 0 | 1].resultSig).toMatch(/^0x/);
    const s = (await call('forkfall_settlement', { matchId })).json;
    expect(s).toMatchObject({ byReferee: false, result: { matchId, turns: state.turn } });
    expect(s.sigA).toMatch(/^0x/);
    expect(s.sigB).toMatch(/^0x/);
    expect(replayLog(await agent.log(matchId)).ok).toBe(true);
  }, 60_000);

  it("shows only the agent's own hand: the opponent's cards are counts, never uids or names", async () => {
    const { json: started } = await call('forkfall_practice', { race: 'agents', botRace: 'prophets' });
    const matchId = started.matchId as Hex;
    const view = (await call('forkfall_state', { matchId })).json;
    const full = lobby.get(matchId).state!;
    const me = view.yourSeat as 0 | 1;
    const opp = me === 0 ? 1 : 0;
    expect(view.yourHand.map((h: { uid: number }) => h.uid)).toEqual(full.players[me].hand.map((h) => h.uid));
    expect(view.players[opp].hand).toBe(full.players[opp].hand.length);
    const oppUids = new Set(full.players[opp].hand.map((h) => h.uid));
    expect(view.yourHand.some((h: { uid: number }) => oppUids.has(h.uid))).toBe(false);
    expect(JSON.stringify(view)).not.toMatch(/deckSalt|seedShare/);
  }, 30_000);

  it('reports bad input as a tool error instead of failing the session', async () => {
    const noRace = await call('forkfall_challenge', { action: 'create' });
    expect(noRace).toMatchObject({ isError: true });
    expect(noRace.text).toMatch(/race is required/);

    const badCode = await call('forkfall_challenge', { action: 'accept', code: 'NOPE', race: 'agents' });
    expect(badCode.isError).toBe(true);

    const { json: started } = await call('forkfall_practice', { race: 'degens' });
    const illegal = await call('forkfall_move', { matchId: started.matchId, action: { type: 'attack', attacker: 999, target: 'treasury' } });
    expect(illegal.isError).toBe(true);
    // The match is still playable afterwards.
    expect((await call('forkfall_state', { matchId: started.matchId })).json.phase).toBe('active');

    const badSchema = await call('forkfall_practice', { race: 'wizards' });
    expect(badSchema.isError).toBe(true);
  }, 30_000);
});
