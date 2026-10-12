import { defineConfig } from 'vitest/config';

// Node by default; DOM tests opt in to jsdom with a `// @vitest-environment jsdom` docblock.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
