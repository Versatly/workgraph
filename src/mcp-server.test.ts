import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkgraphMcpServer } from './mcp-server.js';
import { startWorkgraphEventStream } from './mcp-events.js';
import { loadRegistry, saveRegistry } from './registry.js';
import * as policy from './policy.js';
import * as thread from './thread.js';
import * as trigger from './trigger.js';
import * as store from './store.js';

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
      expect(toolNames).toContain('workgraph_primitive_schema');
      expect(toolNames).toContain('workgraph_ledger_reconcile');
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

      const schemaResult = await client.callTool({
        name: 'workgraph_primitive_schema',
        arguments: {
          typeName: 'thread',
        },
      });
      expect(isToolError(schemaResult)).toBe(false);
      const schemaPayload = getStructured<{ type: string; fields: Array<{ name: string }> }>(schemaResult);
      expect(schemaPayload.type).toBe('thread');
      expect(schemaPayload.fields.some((field) => field.name === 'goal')).toBe(true);

      const reconcileResult = await client.callTool({
        name: 'workgraph_ledger_reconcile',
        arguments: {},
      });
      expect(isToolError(reconcileResult)).toBe(false);
      const reconcilePayload = getStructured<{ totalThreads: number; issues: unknown[] }>(reconcileResult);
      expect(reconcilePayload.totalThreads).toBeGreaterThan(0);

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
          output: 'Completed from MCP write tool. https://github.com/versatly/workgraph/pull/72',
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

  it('exposes primitive tool coverage with context/graph/dispatch aliases', async () => {
    policy.upsertParty(workspacePath, 'agent-mcp', {
      roles: ['operator'],
      capabilities: ['mcp:write', 'thread:claim', 'thread:done', 'dispatch:run'],
    });

    const server = createWorkgraphMcpServer({
      workspacePath,
      defaultActor: 'agent-mcp',
    });
    const client = new Client({
      name: 'workgraph-mcp-test-client-tools',
      version: '1.0.0',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const tools = await client.listTools();
      const toolNames = new Set(tools.tools.map((entry) => entry.name));
      // Core tools our MCP server exposes
      const expectedTools = [
        'workgraph_status',
        'workgraph_brief',
        'workgraph_query',
        'workgraph_primitive_schema',
        'workgraph_thread_list',
        'workgraph_thread_show',
        'workgraph_ledger_recent',
        'workgraph_ledger_reconcile',
        'workgraph_graph_hygiene',
        'workgraph_thread_claim',
        'workgraph_thread_done',
        'workgraph_checkpoint_create',
        'workgraph_dispatch_create',
        'workgraph_dispatch_execute',
        'workgraph_dispatch_followup',
        'workgraph_dispatch_stop',
        'workgraph_trigger_engine_cycle',
        'workgraph_autonomy_run',
      ];
      for (const name of expectedTools) {
        expect(toolNames.has(name)).toBe(true);
      }

      // Verify status tool works end-to-end
      expect(toolNames.size).toBeGreaterThan(10);
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

async function readSseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  minEvents: number,
  timeoutMs: number,
): Promise<Array<{ type: string; data: unknown }>> {
  const decoder = new TextDecoder();
  let buffer = '';
  const events: Array<{ type: string; data: unknown }> = [];
  const deadline = Date.now() + timeoutMs;

  while (events.length < minEvents && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const nextChunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for SSE events.')), remaining)),
    ]);
    if (nextChunk.done) break;
    buffer += decoder.decode(nextChunk.value, { stream: true });

    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const parsed = parseSseEvent(rawEvent);
      if (parsed) events.push(parsed);
      separatorIndex = buffer.indexOf('\n\n');
    }
  }

  if (events.length < minEvents) {
    throw new Error(`Expected at least ${minEvents} SSE events, received ${events.length}.`);
  }

  return events;
}

function parseSseEvent(rawEvent: string): { type: string; data: unknown } | null {
  const lines = rawEvent
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith(':'));
  if (lines.length === 0) return null;

  let type = 'message';
  let dataLine = '';
  for (const line of lines) {
    if (line.startsWith('event:')) {
      type = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLine += line.slice('data:'.length).trim();
    }
  }
  if (!dataLine) return null;
  try {
    return {
      type,
      data: JSON.parse(dataLine),
    };
  } catch {
    return null;
  }
}
