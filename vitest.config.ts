import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.{test,spec}.ts',
      'packages/*/tests/**/*.{test,spec}.ts',
      'tests/**/*.{test,spec}.ts',
    ],
  },
});
