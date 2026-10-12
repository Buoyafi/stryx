import { defineConfig } from 'vitest/config';

// Runs through Vite, so import.meta.glob in src/icons.ts works.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
