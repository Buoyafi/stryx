import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { legalPages } from './vite-legal-plugin.js';

// In dev, /api goes to the Stryx API (the live drops strip reads GET /home/drops), same as the
// dashboard's proxy.
const apiProxy = {
  target: 'http://localhost:3000',
  changeOrigin: true,
  rewrite: (path) => path.replace(/^\/api/, ''),
};

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // /terms.html and /privacy.html are built from docs/legal (vite-legal-plugin.js): one source for the documents.
  plugins: [legalPages()],
  build: {
    rollupOptions: {
      input: { main: resolve(root, 'index.html'), terms: resolve(root, 'terms.html'), privacy: resolve(root, 'privacy.html') },
    },
  },
  server: { proxy: { '/api': apiProxy } },
  preview: { proxy: { '/api': apiProxy } },
});
