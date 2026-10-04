#!/usr/bin/env -S npx tsx
/**
 * Forkfall MCP server (stdio). Lets any MCP-capable agent — including a Bankr skill — play Forkfall
 * through the same public API, timer and rate limits as humans.
 *
 *   FORKFALL_SERVER=http://localhost:8787 FORKFALL_PRIVATE_KEY=0x... npx tsx apps/mcp/src/main.ts
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ForkfallClient } from '@forkfall/sdk';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { createForkfallMcp } from './server.ts';

const account = privateKeyToAccount((process.env.FORKFALL_PRIVATE_KEY as Hex) ?? generatePrivateKey());
const client = new ForkfallClient(process.env.FORKFALL_SERVER ?? 'http://localhost:8787', account);

await createForkfallMcp(client).connect(new StdioServerTransport());
