import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { buildAtlas } from './sprite-atlas.ts';

/**
 * Keep @forkfall/art's embedded Poncho artwork (base64 JPEGs) out of the bundle: the web app loads the same pictures
 * as lazily fetched WebP files (src/assets/poncho, `pnpm art:poncho-web`).
 */
function ponchoImagesAsFiles(): Plugin {
  const stub = fileURLToPath(new URL('./src/lib/ponchoImages.web.ts', import.meta.url));
  return {
    name: 'forkfall:poncho-images-as-files',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './ponchoImages.ts' && importer && /packages[\\/]art[\\/]src[\\/]/.test(importer)) return stub;
    },
  };
}

/**
 * `virtual:forkfall-sprites`: the card sprite atlas (sprite-atlas.ts), built once per build. The PNG is emitted as a
 * hashed asset (inlined as a data URI in dev); the module exports its URL, grid and each card's cell.
 */
function spriteAtlas(): Plugin {
  const ID = 'virtual:forkfall-sprites', RESOLVED = '\0' + ID;
  let dev = false;
  return {
    name: 'forkfall:sprite-atlas',
    configResolved(c) { dev = c.command === 'serve'; },
    resolveId(source) { if (source === ID) return RESOLVED; },
    load(id) {
      if (id !== RESOLVED) return;
      const a = buildAtlas();
      const url = dev
        ? JSON.stringify(`data:image/png;base64,${a.png.toString('base64')}`)
        : `import.meta.ROLLUP_FILE_URL_${this.emitFile({ type: 'asset', name: 'sprites.png', source: a.png })}`;
      return `export default { url: ${url}, cols: ${a.cols}, rows: ${a.rows}, cell: ${a.cell}, pad: ${a.pad}, index: ${JSON.stringify(a.index)} };`;
    },
  };
}

export default defineConfig({
  plugins: [ponchoImagesAsFiles(), spriteAtlas(), react()],
  server: { port: 5173, proxy: { '/v1': { target: 'http://localhost:8787', ws: true } } },
  build: {
    outDir: 'dist',
    target: 'es2022',
    // Wallet SDKs are split out and only load on connect; keep the warning for anything else that grows.
    chunkSizeWarningLimit: 600,
  },
});
