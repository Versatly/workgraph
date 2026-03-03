import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/cli.ts',
    'src/mcp-server.ts',
    'src/mcp-http-server.ts',
    'src/server.ts',
    'src/server-entry.ts',
  ],
  format: ['esm'],
  clean: true,
  splitting: false,
  noExternal: [
    '@versatly/workgraph-kernel',
    '@versatly/workgraph-policy',
    '@versatly/workgraph-cli',
    '@versatly/workgraph-mcp-server',
    '@versatly/workgraph-control-api',
    '@versatly/workgraph-adapter-claude-code',
    '@versatly/workgraph-adapter-cursor-cloud',
    '@versatly/workgraph-obsidian-integration',
    '@versatly/workgraph-runtime-adapter-core',
    '@versatly/workgraph-search-qmd-adapter',
    '@versatly/workgraph-skills',
    '@versatly/workgraph-sdk',
  ],
});
