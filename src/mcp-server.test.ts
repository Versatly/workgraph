import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkgraphMcpServer } from './mcp-server.js';
import { loadRegistry, saveRegistry } from './registry.js';
import * as policy from './policy.js';
import * as thread from './thread.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mcp-server-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('workgraph mcp server', () => {
  it('exposes read tools/resources and enforces policy-scoped write tools', async () => {
    const coordinationThread = thread.createThread(
      workspacePath,
      'MCP task',
      'Validate MCP write path',
      'agent-seed',
      { priority: 'high' },
    );
    thread.createThread(
      workspacePath,
      'MCP follow-up',
      'Validate dispatch execute path',
      'agent-seed',
      { priority: 'medium', deps: [coordinationThread.path] },
    );

    const server = createWorkgraphMcpServer({
      workspacePath,
      defaultActor: 'agent-mcp',
    });
    const client = new Client({
      name: 'workgraph-mcp-test-client',
      version: '1.0.0',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const tools = await client.listTools();
      const toolNames = tools.tools.map((entry) => entry.name);
      expect(toolNames).toContain('workgraph_status');
      expect(toolNames).toContain('workgraph_thread_claim');
      expect(toolNames).toContain('workgraph_dispatch_execute');

      const statusTool = await client.callTool({
        name: 'workgraph_status',
        arguments: {},
      });
      expect('isError' in statusTool && statusTool.isError).toBeFalsy();
      const statusPayload = getStructured<{ threads: { total: number } }>(statusTool);
      expect(statusPayload.threads.total).toBeGreaterThan(0);

      const statusResource = await client.readResource({ uri: 'workgraph://status' });
      const firstContent = statusResource.contents[0];
      const statusText = firstContent && 'text' in firstContent ? firstContent.text : '';
      expect(statusText).toContain('"threads"');

      const blockedWrite = await client.callTool({
        name: 'workgraph_thread_claim',
        arguments: {
          threadPath: coordinationThread.path,
          actor: 'agent-mcp',
        },
      });
      expect(isToolError(blockedWrite)).toBe(true);

      policy.upsertParty(workspacePath, 'agent-mcp', {
        roles: ['operator'],
        capabilities: ['mcp:write', 'thread:claim', 'thread:done', 'dispatch:run'],
      });

      const claimed = await client.callTool({
        name: 'workgraph_thread_claim',
        arguments: {
          threadPath: coordinationThread.path,
          actor: 'agent-mcp',
        },
      });
      expect(isToolError(claimed)).toBe(false);

      const done = await client.callTool({
        name: 'workgraph_thread_done',
        arguments: {
          threadPath: coordinationThread.path,
          actor: 'agent-mcp',
          output: 'Completed from MCP write tool.',
        },
      });
      expect(isToolError(done)).toBe(false);

      const runCreated = await client.callTool({
        name: 'workgraph_dispatch_create',
        arguments: {
          actor: 'agent-mcp',
          objective: 'Execute pending threads from MCP',
        },
      });
      const createdPayload = getStructured<{ run: { id: string } }>(runCreated);
      expect(createdPayload.run.id).toMatch(/^run_/);

      const runExecuted = await client.callTool({
        name: 'workgraph_dispatch_execute',
        arguments: {
          actor: 'agent-mcp',
          runId: createdPayload.run.id,
          agents: ['agent-mcp-1', 'agent-mcp-2'],
          maxSteps: 20,
          stepDelayMs: 0,
        },
      });
      expect(isToolError(runExecuted)).toBe(false);
      const executedPayload = getStructured<{ run: { status: string } }>(runExecuted);
      expect(executedPayload.run.status).toBe('succeeded');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function getStructured<T>(result: unknown): T {
  if (!result || typeof result !== 'object' || !('structuredContent' in result)) {
    throw new Error('Expected structuredContent in MCP tool response.');
  }
  const typed = result as { structuredContent?: unknown };
  if (!typed.structuredContent) {
    throw new Error('Expected structuredContent in MCP tool response.');
  }
  return typed.structuredContent as T;
}

function isToolError(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  if (!('isError' in result)) return false;
  return (result as { isError?: boolean }).isError === true;
}
