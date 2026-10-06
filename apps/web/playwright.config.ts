import { defineConfig, devices } from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Browser tests against the production build (`pnpm web:build`) served by a fresh off-chain referee: no wallet
 * extension, chain or RPC needed (the tests bring their own wallet, see e2e/wallet.ts). Run with `pnpm test:e2e`.
 */
const PORT = 4317;
const data = mkdtempSync(join(tmpdir(), 'forkfall-e2e-'));
const root = resolve(import.meta.dirname, '../..');
// The referee serves apps/web/dist; without it every page is missing and the tests only time out.
if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
  throw new Error('apps/web/dist is missing: run `pnpm web:build` before `pnpm test:e2e`.');
}

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: join(root, 'playwright-report') }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    // CI drives the runner's own Google Chrome (PLAYWRIGHT_CHANNEL=chrome) instead of downloading a browser;
    // PLAYWRIGHT_CHROMIUM points at a specific Chromium binary. Neither set: Playwright's bundled Chromium.
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    ...(process.env.PLAYWRIGHT_CHROMIUM ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM } } : {}),
  },
  webServer: {
    command: 'node --import tsx apps/server/src/main.ts',
    cwd: root,
    url: `http://127.0.0.1:${PORT}/v1/config`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      OFFCHAIN: '1', PORT: String(PORT), BOT_DELAY_MS: '50',
      MATCH_ARCHIVE_DIR: join(data, 'archive'), QUESTS_FILE: join(data, 'quests.json'), INVITES_FILE: join(data, 'invites.json'), SEALED_FILE: join(data, 'sealed.json'), SEALED_BOT_SECONDS: '2', PROFILES_FILE: join(data, 'profiles.json'),
      SETTLEMENT_DIR: join(data, 'settlements'),
    },
  },
});
