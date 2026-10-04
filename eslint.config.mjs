import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Flat config.
 *
 * `globals` was previously absent, so every `self` / `clients` / `OffscreenCanvas`
 * reference in the service worker and worker scripts was reported as
 * `no-undef`, which is why `bun run lint` failed on a clean checkout.
 *
 * `eslint-plugin-react-hooks` is the important addition. The previous config
 * disabled `no-unused-vars` and `no-explicit-any` globally but had no hook rules
 * at all, so the entire class of stale-closure and missing-dependency bugs in
 * the transfer hooks went undetected — which is precisely where the crashes were.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/out/**',
      '**/coverage/**',
      'bun.lock',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  // Browser application code.
  {
    files: ['packages/frontend/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2023 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },

  // Server / Node.
  {
    files: ['packages/backend/**/*.ts', 'packages/protocol/**/*.ts', 'eslint.config.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-console': 'off',
    },
  },

  // Tests: assertions read better without type gymnastics.
  {
    files: ['**/tests/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Web workers and the service worker.
  {
    files: ['packages/frontend/public/**/*.js', 'packages/frontend/scripts/**/*.js'],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.worker },
    },
  },

  // Config files.
  {
    files: ['**/*.config.{ts,mts,js,mjs}', 'packages/frontend/postcss.config.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
);
