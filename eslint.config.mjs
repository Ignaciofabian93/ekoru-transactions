// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'off', // Prisma generates complex types
      '@typescript-eslint/no-unsafe-member-access': 'off', // Prisma generates complex types
      '@typescript-eslint/no-unsafe-call': 'off', // Prisma generates complex types
      '@typescript-eslint/no-unsafe-assignment': 'off', // Prisma generates complex types
      '@typescript-eslint/no-unsafe-return': 'off', // Prisma generates complex types
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/require-await': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
);
