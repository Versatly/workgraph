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
        'workgraph_primitive_types',
        'workgraph_primitive_get',
        'workgraph_primitive_create',
        'workgraph_primitive_update',
        'workgraph_primitive_delete',
        'workgraph_person_list',
        'workgraph_person_get',
        'workgraph_person_create',
        'workgraph_person_update',
        'workgraph_person_archive',
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

  it('supports generic primitive CRUD for shared workspace entities', async () => {
    policy.upsertParty(workspacePath, 'agent-mcp', {
      roles: ['operator'],
      capabilities: ['mcp:write'],
    });

    const server = createWorkgraphMcpServer({
      workspacePath,
      defaultActor: 'agent-mcp',
    });
    const client = new Client({
      name: 'workgraph-mcp-primitive-client',
      version: '1.0.0',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const types = await client.callTool({
        name: 'workgraph_primitive_types',
        arguments: {},
      });
      expect(isToolError(types)).toBe(false);
      const typePayload = getStructured<{ types: Array<{ name: string; retained: boolean; canonical: boolean }> }>(types);
      expect(typePayload.types.some((entry) => entry.name === 'person')).toBe(true);
      expect(typePayload.types.some((entry) => entry.name === 'project')).toBe(true);
      expect(typePayload.types.find((entry) => entry.name === 'person')?.retained).toBe(true);
      expect(typePayload.types.find((entry) => entry.name === 'person')?.canonical).toBe(true);

      const createdPerson = await client.callTool({
        name: 'workgraph_primitive_create',
        arguments: {
          actor: 'agent-mcp',
          type: 'person',
          fields: {
            name: 'Ada Lovelace',
            email: 'ada@example.com',
            role: 'Technical advisor',
            tags: ['vip'],
          },
          body: 'Early stakeholder profile.',
        },
      });
      expect(isToolError(createdPerson)).toBe(false);
      const personPath = getStructured<{ primitive: { path: string; type: string } }>(createdPerson).primitive.path;
      expect(personPath).toBe('people/ada-lovelace.md');

      const fetchedPerson = await client.callTool({
        name: 'workgraph_primitive_get',
        arguments: {
          path: personPath,
        },
      });
      expect(isToolError(fetchedPerson)).toBe(false);
      const fetchedPayload = getStructured<{ primitive: { fields: { email: string } } }>(fetchedPerson);
      expect(fetchedPayload.primitive.fields.email).toBe('ada@example.com');

      const schema = await client.callTool({
        name: 'workgraph_primitive_schema',
        arguments: {
          typeName: 'person',
        },
      });
      expect(isToolError(schema)).toBe(false);
      const schemaPayload = getStructured<{ retained: boolean; canonical: boolean; fields: Array<{ name: string }> }>(schema);
      expect(schemaPayload.retained).toBe(true);
      expect(schemaPayload.canonical).toBe(true);
      expect(schemaPayload.fields.some((field) => field.name === 'preferred_name')).toBe(true);
      expect(schemaPayload.fields.some((field) => field.name === 'job_title')).toBe(true);

      const createdProject = await client.callTool({
        name: 'workgraph_primitive_create',
        arguments: {
          actor: 'agent-mcp',
          type: 'project',
          fields: {
            title: 'Agent Parity Rollout',
            owner: 'agent-mcp',
            member_refs: [personPath],
            status: 'active',
          },
          body: 'Enable full primitive parity for agents.',
        },
      });
      expect(isToolError(createdProject)).toBe(false);
      const projectPath = getStructured<{ primitive: { path: string; fields: { member_refs: string[] } } }>(createdProject);
      expect(projectPath.primitive.path).toBe('projects/agent-parity-rollout.md');
      expect(projectPath.primitive.fields.member_refs).toContain(personPath);

      const updatedProject = await client.callTool({
        name: 'workgraph_primitive_update',
        arguments: {
          actor: 'agent-mcp',
          path: projectPath.primitive.path,
          fieldUpdates: {
            priority: 'high',
          },
          body: 'Enable full primitive parity for agents and MCP clients.',
        },
      });
      expect(isToolError(updatedProject)).toBe(false);
      const updatedPayload = getStructured<{ primitive: { fields: { priority: string }; body: string } }>(updatedProject);
      expect(updatedPayload.primitive.fields.priority).toBe('high');
      expect(updatedPayload.primitive.body).toContain('MCP clients');

      const createdGrace = await client.callTool({
        name: 'workgraph_person_create',
        arguments: {
          actor: 'agent-mcp',
          name: 'Grace Hopper',
          email: 'grace@example.com',
          preferredName: 'Grace',
          jobTitle: 'Rear Admiral',
          organization: 'US Navy',
          tags: ['legend'],
          body: 'Pioneer in compiler design.',
        },
      });
      expect(isToolError(createdGrace)).toBe(false);
      const gracePayload = getStructured<{ person: { path: string; fields: { preferred_name: string; job_title: string } } }>(createdGrace);
      expect(gracePayload.person.path).toBe('people/grace-hopper.md');
      expect(gracePayload.person.fields.preferred_name).toBe('Grace');
      expect(gracePayload.person.fields.job_title).toBe('Rear Admiral');

      const listedPeople = await client.callTool({
        name: 'workgraph_person_list',
        arguments: {
          tag: 'legend',
        },
      });
      expect(isToolError(listedPeople)).toBe(false);
      const listedPeoplePayload = getStructured<{ people: Array<{ path: string }>; count: number }>(listedPeople);
      expect(listedPeoplePayload.count).toBe(1);
      expect(listedPeoplePayload.people[0]?.path).toBe('people/grace-hopper.md');

      const updatedGrace = await client.callTool({
        name: 'workgraph_person_update',
        arguments: {
          actor: 'agent-mcp',
          personPath: 'people/grace-hopper.md',
          fieldUpdates: {
            timezone: 'America/New_York',
          },
        },
      });
      expect(isToolError(updatedGrace)).toBe(false);
      const updatedGracePayload = getStructured<{ person: { fields: { timezone: string } } }>(updatedGrace);
      expect(updatedGracePayload.person.fields.timezone).toBe('America/New_York');

      const archivedGrace = await client.callTool({
        name: 'workgraph_person_archive',
        arguments: {
          actor: 'agent-mcp',
          personPath: 'people/grace-hopper.md',
        },
      });
      expect(isToolError(archivedGrace)).toBe(false);
      expect(storePathExists(workspacePath, 'people/grace-hopper.md')).toBe(false);
      expect(storePathExists(workspacePath, '.workgraph/archive/grace-hopper.md')).toBe(true);

      const deletedPerson = await client.callTool({
        name: 'workgraph_primitive_delete',
        arguments: {
          actor: 'agent-mcp',
          path: personPath,
        },
      });
      expect(isToolError(deletedPerson)).toBe(false);
      expect(storePathExists(workspacePath, personPath)).toBe(false);
      expect(storePathExists(workspacePath, '.workgraph/archive/ada-lovelace.md')).toBe(true);
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

function storePathExists(root: string, relPath: string): boolean {
  return fs.existsSync(path.join(root, relPath));
}
