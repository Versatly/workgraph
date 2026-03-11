import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'packages/sdk/src/index.ts',
    cli: 'packages/cli/src/cli.ts',
    'mcp-server': 'packages/mcp-server/src/mcp-server.ts',
    'mcp-http-server': 'packages/mcp-server/src/mcp-http-server.ts',
    server: 'packages/control-api/src/server.ts',
    'server-entry': 'packages/control-api/src/server-entry.ts',
  },
  format: ['esm'],
  clean: true,
  splitting: false,
  noExternal: [
    '@versatly/workgraph-kernel',
    '@versatly/workgraph-cli',
    '@versatly/workgraph-mcp-server',
    '@versatly/workgraph-control-api',
    '@versatly/workgraph-adapter-claude-code',
    '@versatly/workgraph-adapter-cursor-cloud',
    '@versatly/workgraph-adapter-http-webhook',
    '@versatly/workgraph-adapter-shell-worker',
    '@versatly/workgraph-obsidian-integration',
    '@versatly/workgraph-runtime-adapter-core',
    '@versatly/workgraph-search-qmd-adapter',
    '@versatly/workgraph-skills',
    '@versatly/workgraph-sdk',
  ],
});
