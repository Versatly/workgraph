import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  agent as agentModule,
  registry as registryModule,
  thread as threadModule,
  workspace as workspaceModule,
} from '@versatly/workgraph-kernel';
import { startWorkgraphMcpHttpServer } from './mcp-http-server.js';

const agent = agentModule;
const registry = registryModule;
const thread = threadModule;
const workspace = workspaceModule;

let workspacePath: string;

describe('mcp http server', () => {
  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mcp-http-'));
    registry.saveRegistry(workspacePath, registry.loadRegistry(workspacePath));
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('serves retained tools over streamable http with bearer auth', async () => {
    const init = workspace.initWorkspace(workspacePath, { createReadme: false, createBases: false });
    const registration = agent.registerAgent(workspacePath, 'http-admin', {
      token: init.bootstrapTrustToken,
      role: 'roles/admin.md',
      capabilities: ['mcp:write', 'thread:create', 'thread:claim', 'thread:update', 'thread:complete'],
      actor: 'http-admin',
    });
    thread.createThread(workspacePath, 'HTTP thread', 'Exercise MCP HTTP', 'http-admin');

    const handle = await startWorkgraphMcpHttpServer({
      workspacePath,
      defaultActor: 'http-admin',
      host: '127.0.0.1',
      port: 0,
      bearerToken: 'gateway-token',
    });

    const client = new Client({
      name: 'workgraph-mcp-http-test-client',
      version: '1.0.0',
    });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: {
        headers: {
          authorization: `Bearer ${registration.apiKey}`,
        },
      },
    });

    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === 'workgraph_status')).toBe(true);
      expect(tools.tools.some((tool) => tool.name === 'wg_post_message')).toBe(true);

      const status = await client.callTool({ name: 'workgraph_status', arguments: {} });
      expect(isToolError(status)).toBe(false);

      const claimed = await client.callTool({
        name: 'workgraph_thread_claim',
        arguments: {
          actor: 'http-admin',
          threadPath: 'threads/http-thread.md',
        },
      });
      expect(isToolError(claimed)).toBe(false);
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it('accepts wildcard accept headers during initialization', async () => {
    const handle = await startWorkgraphMcpHttpServer({
      workspacePath,
      defaultActor: 'system',
      host: '127.0.0.1',
      port: 0,
    });

    try {
      const initializeResponse = await fetch(handle.url, {
        method: 'POST',
        headers: {
          accept: '*/*',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: {
              name: 'workgraph-http-client',
              version: '1.0.0',
            },
          },
        }),
      });

      expect(initializeResponse.status).toBe(200);
      expect(initializeResponse.headers.get('mcp-session-id')).toBeTruthy();
    } finally {
      await handle.close();
    }
  });
});

function isToolError(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && 'isError' in result && (result as { isError?: boolean }).isError);
}
