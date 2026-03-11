import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerDefaultDispatchAdaptersIntoKernelRegistry } from '@versatly/workgraph-runtime-adapter-core';
import { registerCollaborationTools } from './mcp/tools/collaboration-tools.js';
import { registerResources } from './mcp/resources.js';
import { registerReadTools } from './mcp/tools/read-tools.js';
import { registerWriteTools } from './mcp/tools/write-tools.js';

const DEFAULT_SERVER_NAME = 'workgraph-mcp-server';
const DEFAULT_SERVER_VERSION = '0.1.0';

export interface WorkgraphMcpServerOptions {
  workspacePath: string;
  defaultActor?: string;
  readOnly?: boolean;
  name?: string;
  version?: string;
}

export function createWorkgraphMcpServer(options: WorkgraphMcpServerOptions): McpServer {
  registerDefaultDispatchAdaptersIntoKernelRegistry();
  const server = new McpServer({
    name: options.name ?? DEFAULT_SERVER_NAME,
    version: options.version ?? DEFAULT_SERVER_VERSION,
  });

  registerResources(server, options);
  registerReadTools(server, options);
  registerWriteTools(server, options);
  registerCollaborationTools(server, options);
  return server;
}

export async function startWorkgraphMcpServer(options: WorkgraphMcpServerOptions): Promise<McpServer> {
  const server = createWorkgraphMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

