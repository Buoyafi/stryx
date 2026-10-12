import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy /api to the backend, so the browser talks to the dashboard's own origin.
const apiProxy = {
  target: 'http://localhost:3000',
  changeOrigin: true,
  rewrite: (path: string) => path.replace(/^\/api/, ''),
};

export default defineConfig({
  plugins: [react()],
  build: {
    // The one chunk over Vite's 500 kB default is WalletConnect's code, loaded only when someone picks
    // "Phone wallet".
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      onwarn(warning, warn) {
        // A /*#__PURE__*/ comment Rollup cannot place, inside a WalletConnect dependency (ox): it only
        // drops the comment.
        if (warning.code === 'INVALID_ANNOTATION' && warning.id?.includes('node_modules')) return;
        warn(warning);
      },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': apiProxy },
  },
  // `vite preview` serves the production build; it forwards /api the same way, so a build can be tried locally.
  preview: {
    port: 4173,
    proxy: { '/api': apiProxy },
  },
});
