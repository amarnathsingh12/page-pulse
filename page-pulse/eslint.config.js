const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', 'eslint.config.js', 'vitest.config.ts'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
);
