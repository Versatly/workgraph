import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadRegistry, saveRegistry } from './registry.js';
import * as policy from './policy.js';
import * as thread from './thread.js';
import { startWorkgraphMcpHttpServer } from './mcp-http-server.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mcp-http-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('mcp streamable http server', () => {
  it('serves MCP tools over HTTP with bearer token auth', async () => {
    policy.upsertParty(workspacePath, 'http-operator', {
      roles: ['operator'],
      capabilities: ['mcp:write', 'thread:claim', 'thread:done', 'dispatch:run'],
    });
    thread.createThread(workspacePath, 'HTTP MCP task', 'Execute via MCP HTTP', 'seed', { priority: 'high' });

    const handle = await startWorkgraphMcpHttpServer({
      workspacePath,
      defaultActor: 'http-operator',
      host: '127.0.0.1',
      port: 0,
      bearerToken: 'secret-token',
    });

    const client = new Client({
      name: 'workgraph-mcp-http-test-client',
      version: '1.0.0',
    });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: {
        headers: {
          authorization: 'Bearer secret-token',
        },
      },
    });

    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === 'workgraph_status')).toBe(true);

      const status = await client.callTool({
        name: 'workgraph_status',
        arguments: {},
      });
      expect(isToolError(status)).toBe(false);

      const runCreated = await client.callTool({
        name: 'workgraph_dispatch_create',
        arguments: {
          actor: 'http-operator',
          objective: 'HTTP MCP run',
        },
      });
      const runId = extractStructured<{ run: { id: string } }>(runCreated).run.id;
      const runExecuted = await client.callTool({
        name: 'workgraph_dispatch_execute',
        arguments: {
          actor: 'http-operator',
          runId,
          agents: ['http-agent-1', 'http-agent-2'],
          maxSteps: 30,
          stepDelayMs: 0,
        },
      });
      const executed = extractStructured<{ run: { status: string } }>(runExecuted);
      expect(executed.run.status).toBe('succeeded');
    } finally {
      await client.close();
      await handle.close();
    }
  });
});

function extractStructured<T>(result: unknown): T {
  if (!result || typeof result !== 'object' || !('structuredContent' in result)) {
    throw new Error('Expected structuredContent in MCP result.');
  }
  return (result as { structuredContent: T }).structuredContent;
}

function isToolError(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  if (!('isError' in result)) return false;
  return (result as { isError?: boolean }).isError === true;
}
