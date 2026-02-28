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
      const primitiveTypes = [
        'thread',
        'fact',
        'decision',
        'lesson',
        'agent',
        'skill',
        'policy',
        'incident',
        'trigger',
        'checkpoint',
        'run',
        'person',
        'project',
        'client',
        'space',
      ];

      for (const typeName of primitiveTypes) {
        const createName = `workgraph_${typeName}_create`;
        const readName = `workgraph_${typeName}_read`;
        const updateName = `workgraph_${typeName}_update`;
        const listName = typeName === 'thread'
          ? 'workgraph_thread_list'
          : `workgraph_${typeName}_list`;
        const searchName = `workgraph_${typeName}_search`;
        if (typeName !== 'checkpoint') {
          expect(toolNames.has(createName)).toBe(true);
        } else {
          expect(toolNames.has('workgraph_checkpoint_create')).toBe(true);
        }
        expect(toolNames.has(readName)).toBe(true);
        expect(toolNames.has(updateName)).toBe(true);
        expect(toolNames.has(listName)).toBe(true);
        expect(toolNames.has(searchName)).toBe(true);
      }

      expect(toolNames.has('workgraph_context')).toBe(true);
      expect(toolNames.has('workgraph_neighborhood')).toBe(true);
      expect(toolNames.has('workgraph_impact')).toBe(true);
      expect(toolNames.has('workgraph_search')).toBe(true);
      expect(toolNames.has('workgraph_claim')).toBe(true);
      expect(toolNames.has('workgraph_complete')).toBe(true);
      expect(toolNames.has('workgraph_heartbeat')).toBe(true);
      expect(toolNames.has('workgraph_handoff')).toBe(true);

      const personCreated = await client.callTool({
        name: 'workgraph_person_create',
        arguments: {
          actor: 'agent-mcp',
          fields: {
            name: 'Jane Doe',
            email: 'jane@example.com',
          },
          body: 'Primary stakeholder for auth project.',
        },
      });
      expect(isToolError(personCreated)).toBe(false);

      const personRead = await client.callTool({
        name: 'workgraph_person_read',
        arguments: {
          ref: 'jane-doe',
        },
      });
      const personReadPayload = getStructured<{ primitive: { path: string } }>(personRead);
      expect(personReadPayload.primitive.path).toBe('people/jane-doe.md');

      const personUpdated = await client.callTool({
        name: 'workgraph_person_update',
        arguments: {
          actor: 'agent-mcp',
          ref: 'jane-doe',
          fields: {
            role: 'Engineering Manager',
          },
        },
      });
      expect(isToolError(personUpdated)).toBe(false);

      const personList = await client.callTool({
        name: 'workgraph_person_list',
        arguments: {},
      });
      const personListPayload = getStructured<{ count: number }>(personList);
      expect(personListPayload.count).toBe(1);

      const personSearch = await client.callTool({
        name: 'workgraph_person_search',
        arguments: {
          text: 'engineering',
        },
      });
      const personSearchPayload = getStructured<{ count: number }>(personSearch);
      expect(personSearchPayload.count).toBe(1);

      const decisionCreated = await client.callTool({
        name: 'workgraph_decision_create',
        arguments: {
          actor: 'agent-mcp',
          path: 'decisions/auth-architecture.md',
          fields: {
            title: 'Auth Architecture',
            date: '2026-02-28T00:00:00.000Z',
          },
          body: 'Token model for auth rollout.',
        },
      });
      expect(isToolError(decisionCreated)).toBe(false);

      const factCreated = await client.callTool({
        name: 'workgraph_fact_create',
        arguments: {
          actor: 'agent-mcp',
          path: 'facts/token-ttl.md',
          fields: {
            subject: 'token',
            predicate: 'ttl',
            object: '15m',
          },
          body: 'Linked to [[threads/context-anchor.md]].',
        },
      });
      expect(isToolError(factCreated)).toBe(false);

      const lessonCreated = await client.callTool({
        name: 'workgraph_lesson_create',
        arguments: {
          actor: 'agent-mcp',
          path: 'lessons/auth-rollout.md',
          fields: {
            title: 'Auth rollout lesson',
            date: '2026-02-28T00:00:00.000Z',
          },
          body: 'Always dry-run migration scripts first.',
        },
      });
      expect(isToolError(lessonCreated)).toBe(false);

      const threadCreated = await client.callTool({
        name: 'workgraph_thread_create',
        arguments: {
          actor: 'agent-mcp',
          fields: {
            title: 'Context anchor',
            goal: 'Implement [[decisions/auth-architecture.md]] and verify [[facts/token-ttl.md]].',
            tags: ['auth'],
          },
          body: 'Thread guidance references [[lessons/auth-rollout.md]].',
        },
      });
      const threadPayload = getStructured<{ primitive: { path: string } }>(threadCreated);
      expect(threadPayload.primitive.path).toBe('threads/context-anchor.md');

      const contextResult = await client.callTool({
        name: 'workgraph_context',
        arguments: {
          threadSlug: 'context-anchor',
          budget: 8000,
        },
      });
      const contextPayload = getStructured<{ markdown: string; includedPaths: string[] }>(contextResult);
      expect(contextPayload.markdown).toContain('threads/context-anchor.md');
      expect(contextPayload.markdown).toContain('decisions/auth-architecture.md');
      expect(contextPayload.includedPaths).toContain('threads/context-anchor.md');

      const neighborhood = await client.callTool({
        name: 'workgraph_neighborhood',
        arguments: {
          primitiveRef: 'threads/context-anchor.md',
          hops: 2,
          refresh: true,
        },
      });
      const neighborhoodPayload = getStructured<{ count: number }>(neighborhood);
      expect(neighborhoodPayload.count).toBeGreaterThan(1);

      const impact = await client.callTool({
        name: 'workgraph_impact',
        arguments: {
          primitiveRef: 'decisions/auth-architecture.md',
        },
      });
      const impactPayload = getStructured<{ references: Array<{ source: string }> }>(impact);
      expect(impactPayload.references.some((entry) => entry.source === 'threads/context-anchor.md')).toBe(true);

      const search = await client.callTool({
        name: 'workgraph_search',
        arguments: {
          text: 'auth',
        },
      });
      const searchPayload = getStructured<{ count: number }>(search);
      expect(searchPayload.count).toBeGreaterThan(0);

      const dispatchRun = await client.callTool({
        name: 'workgraph_dispatch_create',
        arguments: {
          actor: 'agent-mcp',
          objective: 'Finalize auth rollout',
        },
      });
      const runPayload = getStructured<{ run: { id: string } }>(dispatchRun);

      const completeRun = await client.callTool({
        name: 'workgraph_complete',
        arguments: {
          actor: 'agent-mcp',
          runId: runPayload.run.id,
          output: 'Run completed via alias tool.',
        },
      });
      const completePayload = getStructured<{ run: { status: string } }>(completeRun);
      expect(completePayload.run.status).toBe('succeeded');

      const handoffThread = await client.callTool({
        name: 'workgraph_thread_create',
        arguments: {
          actor: 'agent-mcp',
          fields: {
            title: 'Handoff target',
            goal: 'Prepare handoff lifecycle test.',
          },
        },
      });
      const handoffThreadPath = getStructured<{ primitive: { path: string } }>(handoffThread).primitive.path;

      const claimed = await client.callTool({
        name: 'workgraph_claim',
        arguments: {
          actor: 'agent-mcp',
          threadPath: handoffThreadPath,
        },
      });
      expect(isToolError(claimed)).toBe(false);

      const heartbeated = await client.callTool({
        name: 'workgraph_heartbeat',
        arguments: {
          actor: 'agent-mcp',
          threadPath: handoffThreadPath,
          leaseMinutes: 20,
        },
      });
      expect(isToolError(heartbeated)).toBe(false);

      const handedOff = await client.callTool({
        name: 'workgraph_handoff',
        arguments: {
          fromActor: 'agent-mcp',
          toActor: 'agent-b',
          threadPath: handoffThreadPath,
          note: 'Transfer for follow-on implementation.',
        },
      });
      const handoffPayload = getStructured<{ thread: { fields: { owner: string } } }>(handedOff);
      expect(handoffPayload.thread.fields.owner).toBe('agent-b');

      const statusResult = await client.callTool({
        name: 'workgraph_status',
        arguments: {},
      });
      const statusPayload = getStructured<{
        primitives: { byType: Record<string, number> };
        claims: { entries: Array<{ target: string }> };
        threads: { activeItems: Array<{ path: string }> };
        triggers: { byStatus: Record<string, number> };
      }>(statusResult);
      expect(statusPayload.primitives.byType.thread).toBeGreaterThan(0);
      expect(Array.isArray(statusPayload.claims.entries)).toBe(true);
      expect(Array.isArray(statusPayload.threads.activeItems)).toBe(true);
      expect(typeof statusPayload.triggers.byStatus).toBe('object');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('streams SSE events for primitive, thread, and trigger lifecycle', async () => {
    const stream = await startWorkgraphEventStream({
      workspacePath,
      port: 0,
      pollIntervalMs: 20,
      heartbeatMs: 1000,
    });
    const response = await fetch(stream.url, {
      headers: {
        Accept: 'text/event-stream',
      },
    });
    if (!response.body) {
      throw new Error('Expected SSE response body.');
    }
    const reader = response.body.getReader();

    try {
      const lifecycleThread = thread.createThread(workspacePath, 'SSE thread', 'Observe lifecycle', 'agent-a');
      thread.claim(workspacePath, lifecycleThread.path, 'agent-a');
      thread.done(workspacePath, lifecycleThread.path, 'agent-a', 'SSE lifecycle complete');

      const triggerPrimitive = store.create(
        workspacePath,
        'trigger',
        {
          title: 'SSE Trigger',
          event: 'release',
          action: 'dispatch',
          status: 'approved',
        },
        'Trigger for SSE test',
        'system',
      );
      trigger.fireTrigger(workspacePath, triggerPrimitive.path, {
        actor: 'system',
        eventKey: 'event-1',
      });

      const events = await readSseEvents(reader, 4, 7000);
      const eventTypes = events.map((event) => event.type);
      expect(eventTypes).toContain('primitive.created');
      expect(eventTypes).toContain('thread.claimed');
      expect(eventTypes).toContain('thread.completed');
      expect(eventTypes).toContain('trigger.fired');
    } finally {
      await reader.cancel();
      await stream.close();
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
