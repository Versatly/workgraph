import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'packages/sdk/src/index.ts',
    cli: 'packages/cli/src/cli.ts',
    'mcp-server': 'packages/mcp-server/src/mcp-server.ts',
    'mcp-http-server': 'packages/mcp-server/src/mcp-http-server.ts',
  },
  format: ['esm'],
  clean: true,
  splitting: false,
  noExternal: [
    '@versatly/workgraph-kernel',
    '@versatly/workgraph-cli',
    '@versatly/workgraph-mcp-server',
    '@versatly/workgraph-sdk',
  ],
});
