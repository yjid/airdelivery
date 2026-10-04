import js from '@eslint/js';
import ts from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  prettier,
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.next/**', '**/out/**'],
  },
  // Worker and service-worker scripts run outside the page, so browser globals
  // like `self` are absent from this configuration and every reference was
  // reported as undefined.
  {
    files: ['**/public/**/*.js', '**/scripts/**/*.js'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.worker } },
  },
  {
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-empty': 'off',
      'no-useless-escape': 'off',
    },
  }
);
