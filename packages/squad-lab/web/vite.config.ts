import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by the lab's own Fastify under `/app/`, the same shape ADP uses for
// its supervision UI. `base` has to match the mount point or every asset URL
// the build emits is wrong the moment it is served from anywhere but root.
export default defineConfig({
  plugins: [react()],
  // Anchored to this file rather than left to default to the working
  // directory: the package's scripts run from `packages/squad-lab`, so a
  // relative root would look for `index.html` one level up from where it is.
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/app/',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // In dev the SPA runs on Vite's port and the lab on its own, so both API
    // surfaces are proxied rather than duplicated behind a second origin —
    // which would need CORS on the lab, and the whole point of the read proxy
    // is not needing it.
    proxy: {
      '/api': 'http://127.0.0.1:7317',
      '/adp': 'http://127.0.0.1:7317',
    },
  },
});
