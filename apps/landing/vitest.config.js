import { defineConfig } from 'vitest/config';

// Every test here targets pure logic that needs no DOM.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
