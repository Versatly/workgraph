import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { orientation as orientationModule } from '@versatly/workgraph-kernel';
import { toPrettyJson } from './result.js';
import { type WorkgraphMcpServerOptions } from './types.js';

const orientation = orientationModule;

export function registerResources(server: McpServer, options: WorkgraphMcpServerOptions): void {
  server.registerResource(
    'workspace-status',
    'workgraph://status',
    {
      title: 'Workgraph Status Snapshot',
      description: 'Current thread/claim/primitive counts for the workspace.',
      mimeType: 'application/json',
    },
    async () => {
      const snapshot = orientation.statusSnapshot(options.workspacePath);
      return {
        contents: [
          {
            uri: 'workgraph://status',
            mimeType: 'application/json',
            text: toPrettyJson(snapshot),
          },
        ],
      };
    },
  );

  server.registerResource(
    'actor-brief',
    new ResourceTemplate('workgraph://brief/{actor}', { list: undefined }),
    {
      title: 'Actor Brief',
      description: 'Actor-specific operational brief derived from workspace state.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const actor = String(variables.actor ?? options.defaultActor ?? 'anonymous');
      const brief = orientation.brief(options.workspacePath, actor);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: toPrettyJson(brief),
          },
        ],
      };
    },
  );
}
