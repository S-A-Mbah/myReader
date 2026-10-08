import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', '.cache/', 'coverage/'] },
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'test/**/*.js', 'test/**/*.mjs', '*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    files: ['src/shared/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: {} },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'prefer-const': 'error',
    },
  },
];
