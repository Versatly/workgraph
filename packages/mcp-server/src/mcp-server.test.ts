import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  policy as policyModule,
  registry as registryModule,
  thread as threadModule,
  workspace as workspaceModule,
} from '@versatly/workgraph-kernel';
import { createWorkgraphMcpServer } from './mcp-server.js';

const policy = policyModule;
const registry = registryModule;
const thread = threadModule;
const workspace = workspaceModule;

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mcp-server-'));
  workspace.initWorkspace(workspacePath, {
    createReadme: false,
    createBases: false,
  });
  registry.saveRegistry(workspacePath, registry.loadRegistry(workspacePath));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('workgraph mcp server', () => {
  it('exposes the retained tools and resources', async () => {
    policy.upsertParty(workspacePath, 'agent-mcp', {
      roles: ['operator'],
      capabilities: ['mcp:write', 'thread:create', 'thread:update', 'thread:claim', 'thread:complete', 'agent:register'],
    });

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
      const toolNames = new Set(tools.tools.map((entry) => entry.name));
      for (const toolName of [
        'workgraph_status',
        'workgraph_brief',
        'workgraph_company_context',
        'workgraph_query',
        'workgraph_search',
        'workgraph_lens_list',
        'workgraph_lens_show',
        'workgraph_primitive_schema',
        'workgraph_thread_list',
        'workgraph_thread_show',
        'workgraph_agent_list',
        'workgraph_graph_hygiene',
        'workgraph_thread_create',
        'workgraph_thread_claim',
        'workgraph_thread_block',
        'workgraph_thread_unblock',
        'workgraph_thread_handoff',
        'workgraph_thread_release',
        'workgraph_thread_heartbeat',
        'workgraph_thread_join',
        'workgraph_thread_done',
        'workgraph_checkpoint_create',
        'workgraph_agent_register',
        'workgraph_agent_request_registration',
        'workgraph_agent_list_registration_requests',
        'workgraph_agent_review_registration',
        'workgraph_agent_heartbeat',
        'wg_post_message',
        'wg_ask',
        'wg_create_thread',
        'wg_spawn_thread',
        'wg_thread_context_add',
        'wg_thread_context_search',
        'wg_thread_context_list',
        'wg_thread_context_prune',
        'wg_heartbeat',
      ]) {
        expect(toolNames.has(toolName)).toBe(true);
      }

      const statusTool = await client.callTool({
        name: 'workgraph_status',
        arguments: {},
      });
      expect(isToolError(statusTool)).toBe(false);
      const statusPayload = getStructured<{ threads: { total: number } }>(statusTool);
      expect(statusPayload.threads.total).toBe(0);

      const statusResource = await client.readResource({ uri: 'workgraph://status' });
      const firstContent = statusResource.contents[0];
      const statusText = firstContent && 'text' in firstContent ? firstContent.text : '';
      expect(statusText).toContain('"threads"');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('supports retained thread and collaboration flows end-to-end', async () => {
    const initPolicy = policy.upsertParty(workspacePath, 'agent-mcp', {
      roles: ['operator'],
      capabilities: ['mcp:write', 'thread:create', 'thread:update', 'thread:claim', 'thread:complete', 'agent:register'],
    });
    expect(initPolicy.id).toBe('agent-mcp');

    const seededThread = thread.createThread(
      workspacePath,
      'Parent collaboration thread',
      'Coordinate MCP collaboration flow',
      'agent-seed',
    );

    const server = createWorkgraphMcpServer({
      workspacePath,
      defaultActor: 'agent-mcp',
    });
    const client = new Client({
      name: 'workgraph-mcp-collaboration-client',
      version: '1.0.0',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const created = await client.callTool({
        name: 'workgraph_thread_create',
        arguments: {
          actor: 'agent-mcp',
          title: 'MCP created thread',
          goal: 'Validate retained MCP thread tools.',
          priority: 'high',
          tags: ['mcp'],
        },
      });
      expect(isToolError(created)).toBe(false);
      const createdPath = getStructured<{ thread: { path: string } }>(created).thread.path;

      const claimed = await client.callTool({
        name: 'workgraph_thread_claim',
        arguments: {
          actor: 'agent-mcp',
          threadPath: createdPath,
        },
      });
      expect(isToolError(claimed)).toBe(false);

      const contextAdded = await client.callTool({
        name: 'wg_thread_context_add',
        arguments: {
          actor: 'agent-mcp',
          threadPath: createdPath,
          title: 'Decision context',
          content: 'Capture the key collaboration context for this thread.',
          source: 'docs/context.md',
          relevance: 0.8,
        },
      });
      expect(isToolError(contextAdded)).toBe(false);

      const contextSearch = await client.callTool({
        name: 'wg_thread_context_search',
        arguments: {
          actor: 'agent-mcp',
          threadPath: createdPath,
          query: 'collaboration context',
          limit: 5,
        },
      });
      expect(isToolError(contextSearch)).toBe(false);
      const contextPayload = getStructured<{ data: { count: number } }>(contextSearch);
      expect(contextPayload.data.count).toBe(1);

      const posted = await client.callTool({
        name: 'wg_post_message',
        arguments: {
          actor: 'agent-mcp',
          threadPath: createdPath,
          body: 'Coordination message from MCP.',
          idempotencyKey: 'post-1',
        },
      });
      expect(isToolError(posted)).toBe(false);
      const replayed = await client.callTool({
        name: 'wg_post_message',
        arguments: {
          actor: 'agent-mcp',
          threadPath: createdPath,
          body: 'Coordination message from MCP.',
          idempotencyKey: 'post-1',
        },
      });
      expect(isToolError(replayed)).toBe(false);
      const replayPayload = getStructured<{ data: { operation: string } }>(replayed);
      expect(replayPayload.data.operation).toBe('replayed');

      const asked = await client.callTool({
        name: 'wg_ask',
        arguments: {
          actor: 'agent-mcp',
          threadPath: createdPath,
          question: 'Can you confirm the current status?',
          idempotencyKey: 'ask-1',
          awaitReply: false,
        },
      });
      expect(isToolError(asked)).toBe(false);

      const spawned = await client.callTool({
        name: 'wg_spawn_thread',
        arguments: {
          actor: 'agent-mcp',
          parentThreadPath: seededThread.path,
          title: 'Spawned child thread',
          goal: 'Handle a collaboration child task.',
          idempotencyKey: 'spawn-1',
        },
      });
      expect(isToolError(spawned)).toBe(false);

      const heartbeat = await client.callTool({
        name: 'wg_heartbeat',
        arguments: {
          actor: 'agent-mcp',
          status: 'busy',
          currentWork: createdPath,
          threadPath: createdPath,
          threadLeaseMinutes: 10,
        },
      });
      expect(isToolError(heartbeat)).toBe(false);

      const done = await client.callTool({
        name: 'workgraph_thread_done',
        arguments: {
          actor: 'agent-mcp',
          threadPath: createdPath,
          output: 'Finished via MCP https://github.com/versatly/workgraph/pull/999',
          evidence: ['https://github.com/versatly/workgraph/pull/999'],
        },
      });
      expect(isToolError(done)).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('supports actor registration request and review tools', async () => {
    policy.upsertParty(workspacePath, 'admin-reviewer', {
      roles: ['admin'],
      capabilities: ['mcp:write', 'agent:register', 'agent:approve-registration', 'policy:manage'],
    }, {
      actor: 'system',
      skipAuthorization: true,
    });

    const server = createWorkgraphMcpServer({
      workspacePath,
      defaultActor: 'admin-reviewer',
    });
    const client = new Client({
      name: 'workgraph-mcp-registration-client',
      version: '1.0.0',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const requested = await client.callTool({
        name: 'workgraph_agent_request_registration',
        arguments: {
          actor: 'candidate-agent',
          name: 'candidate-agent',
          role: 'roles/contributor.md',
          capabilities: ['thread:create'],
          note: 'Please approve me for collaboration work.',
        },
      });
      expect(isToolError(requested)).toBe(false);
      const requestPath = getStructured<{ request: { path: string } }>(requested).request.path;

      const listed = await client.callTool({
        name: 'workgraph_agent_list_registration_requests',
        arguments: {
          actor: 'admin-reviewer',
          status: 'pending',
        },
      });
      expect(isToolError(listed)).toBe(false);
      const listedPayload = getStructured<{ count: number }>(listed);
      expect(listedPayload.count).toBe(1);

      const reviewed = await client.callTool({
        name: 'workgraph_agent_review_registration',
        arguments: {
          actor: 'admin-reviewer',
          requestRef: requestPath,
          decision: 'approved',
          role: 'roles/contributor.md',
          capabilities: ['thread:create', 'thread:update'],
          note: 'Approved for retained-scope collaboration work.',
        },
      });
      expect(isToolError(reviewed)).toBe(false);
      const reviewPayload = getStructured<{ decision: string; request: { fields: { status: string } } }>(reviewed);
      expect(reviewPayload.decision).toBe('approved');
      expect(reviewPayload.request.fields.status).toBe('approved');
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
