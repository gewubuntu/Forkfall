import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/v1': 'http://localhost:8787' } },
  build: {
    outDir: 'dist',
    target: 'es2022',
    rolldownOptions: {
      input: { main: resolve(__dirname, 'index.html'), legacy: resolve(__dirname, 'legacy.html') },
    },
  },
});
