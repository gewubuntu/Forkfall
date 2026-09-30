import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, proxy: { '/v1': 'http://localhost:8787' } },
  build: { outDir: 'dist', target: 'es2022' },
});
