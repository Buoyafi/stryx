import { defineConfig } from 'vitest/config';

// DOM tests opt in to jsdom with a `// @vitest-environment jsdom` docblock; the rest (core.ts's pure
// queue logic) stay in node.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
