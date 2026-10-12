// Flat config (ESLint 9), lowest precedence first: JS recommended, the TypeScript rules, per-area
// globals, then our overrides. Type-aware rules are off: `npm run typecheck` covers types.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node is the default runtime for api, services, packages and workers.
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // The dashboard is a Vite/React browser bundle.
    files: ['apps/dashboard/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // The landing page is a plain-JS browser bundle.
    files: ['apps/landing/src/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // brand/*.js is shared browser script, loaded by a plain <script> tag.
    files: ['brand/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['**/tests/**/*.{ts,tsx}', '**/*.{test,spec}.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest },
    },
  },
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // The TS-aware version understands type-only imports, enums and overloads.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];
