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

/**
 * Deep links (a match after coming back from a wallet app, a lesson, a challenge link) would fetch their page's chunk
 * only after the main bundle has run. A few bytes of inline script start those downloads with the main bundle.
 */
function routeModulePreload(routes: Record<string, string>): Plugin {
  return {
    name: 'forkfall:route-modulepreload',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return;
        const map: Record<string, string[]> = {};
        for (const [prefix, mod] of Object.entries(routes)) {
          const entry = Object.values(bundle).find((c) => c.type === 'chunk' && c.facadeModuleId?.endsWith(mod));
          if (!entry) continue;
          const files = new Set<string>();
          const walk = (f: string) => {
            const c = bundle[f];
            if (files.has(f) || c?.type !== 'chunk') return;
            files.add(f);
            c.imports.forEach(walk);
          };
          walk(entry.fileName);
          map[prefix] = [...files];
        }
        const js = `(function(m){var p=location.pathname;for(var k in m)if(p.indexOf(k)===0)m[k].forEach(function(f){var l=document.createElement('link');l.rel='modulepreload';l.crossOrigin='';l.href='/'+f;document.head.appendChild(l)})})(${JSON.stringify(map)})`;
        // Before the stylesheet: an inline script after a <link rel=stylesheet> waits for the CSS to download, which
        // held these preloads back by a whole round trip. (Not head-prepend: <meta charset> must stay in the first 1 KB.)
        const at = html.search(/<link rel="stylesheet"/);
        const tag = `<script>${js}</script>\n    `;
        return at < 0 ? html.replace('</head>', `${tag}</head>`) : html.slice(0, at) + tag + html.slice(at);
      },
    },
  };
}

export default defineConfig({
  plugins: [
    ponchoImagesAsFiles(), spriteAtlas(), react(),
    routeModulePreload({ '/match/': 'src/pages/Match.tsx', '/learn/': 'src/pages/Learn.tsx', '/challenge/': 'src/pages/Challenge.tsx', '/play': 'src/pages/Play.tsx' }),
  ],
  server: { port: 5173, proxy: { '/v1': { target: 'http://localhost:8787', ws: true } } },
  build: {
    outDir: 'dist',
    target: 'es2022',
    // Wallet SDKs are split out and only load on connect; keep the warning for anything else that grows.
    chunkSizeWarningLimit: 600,
  },
});
