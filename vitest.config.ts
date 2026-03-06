import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@versatly/workgraph-mcp-server': path.join(repoRoot, 'packages/mcp-server/src/index.ts'),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.{test,spec}.ts',
      'packages/*/tests/**/*.{test,spec}.ts',
      'tests/**/*.{test,spec}.ts',
    ],
  },
});
