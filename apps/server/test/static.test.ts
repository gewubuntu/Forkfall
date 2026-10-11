import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Chain } from '../src/chain.ts';
import { createApi } from '../src/http.ts';
import { Lobby } from '../src/lobby.ts';

const dir = mkdtempSync(join(tmpdir(), 'forkfall-static-'));
mkdirSync(join(dir, 'assets'));
const js = `export const big = ${JSON.stringify('x'.repeat(5000))};`;
writeFileSync(join(dir, 'index.html'), `<!doctype html><title>Forkfall</title>${' '.repeat(2000)}`);
writeFileSync(join(dir, 'assets/index-abc123.js'), js);
writeFileSync(join(dir, 'assets/42-def456.webp'), Buffer.alloc(3000, 1));
writeFileSync(join(dir, 'assets/inter-latin.woff2'), Buffer.alloc(2000, 2));

const lobby = new Lobby({ chain: new Chain(null), house: privateKeyToAccount(generatePrivateKey()) });
const { server } = createApi(lobby, { staticDir: dir, ratePerSec: 10_000 });
let url = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

/** fetch() would decompress on its own and hide the encoding: read raw bytes with node:http instead. */
async function get(path: string, encoding?: string) {
  const { request } = await import('node:http');
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    request(url + path, { headers: encoding ? { 'accept-encoding': encoding } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
}

describe('web app files (phones on 4G)', () => {
  it('caches hashed build output for a year and revalidates the page', async () => {
    const asset = await get('/assets/index-abc123.js');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.headers['content-type']).toBe('text/javascript');
    const page = await get('/play');
    expect(page.headers['cache-control']).toBe('no-cache');
    expect(page.body.toString()).toContain('<title>Forkfall</title>');
  });

  it('compresses text with brotli or gzip as the client accepts, and sends it plain otherwise', async () => {
    const br = await get('/assets/index-abc123.js', 'gzip, deflate, br');
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers.vary).toBe('accept-encoding');
    expect(brotliDecompressSync(br.body).toString()).toBe(js);
    expect(br.body.length).toBeLessThan(js.length / 10);
    const gz = await get('/assets/index-abc123.js', 'gzip');
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gz.body).toString()).toBe(js);
    const plain = await get('/assets/index-abc123.js');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.toString()).toBe(js);
  });

  it('serves images and fonts with their types, uncompressed', async () => {
    const img = await get('/assets/42-def456.webp', 'br');
    expect(img.headers['content-type']).toBe('image/webp');
    expect(img.headers['content-encoding']).toBeUndefined();
    expect((await get('/assets/inter-latin.woff2')).headers['content-type']).toBe('font/woff2');
  });

  it('answers a missing build file with 404 instead of the app page', async () => {
    expect((await get('/assets/index-old999.js')).status).toBe(404);
  });
});
