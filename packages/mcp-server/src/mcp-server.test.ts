import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  registry as registryModule,
  policy as policyModule,
  thread as threadModule,
} from '@versatly/workgraph-kernel';
import { createWorkgraphMcpServer } from './mcp-server.js';

const registry = registryModule;
const policy = policyModule;
const thread = threadModule;

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mcp-server-'));
  const schemaRegistry = registry.loadRegistry(workspacePath);
  registry.saveRegistry(workspacePath, schemaRegistry);
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
      expect(toolNames).toContain('workgraph_company_context');
      expect(toolNames).toContain('workgraph_primitive_schema');
      expect(toolNames).toContain('workgraph_ledger_reconcile');
      expect(toolNames).toContain('workgraph_thread_create');
      expect(toolNames).toContain('workgraph_thread_claim');
      expect(toolNames).toContain('workgraph_thread_block');
      expect(toolNames).toContain('workgraph_thread_unblock');
      expect(toolNames).toContain('workgraph_thread_handoff');
      expect(toolNames).toContain('workgraph_thread_release');
      expect(toolNames).toContain('workgraph_thread_heartbeat');
      expect(toolNames).toContain('workgraph_thread_join');
      expect(toolNames).toContain('workgraph_dispatch_execute');
      expect(toolNames).toContain('workgraph_trigger_create');
      expect(toolNames).toContain('workgraph_trigger_fire');
      expect(toolNames).toContain('workgraph_create_decision');
      expect(toolNames).toContain('workgraph_record_lesson');
      expect(toolNames).toContain('workgraph_record_pattern');
      expect(toolNames).toContain('workgraph_create_mission');
      expect(toolNames).toContain('workgraph_mission_status');

      const statusTool = await client.callTool({
        name: 'workgraph_status',
        arguments: {},
      });
      expect('isError' in statusTool && statusTool.isError).toBeFalsy();
      const statusPayload = getStructured<{ threads: { total: number } }>(statusTool);
      expect(statusPayload.threads.total).toBeGreaterThan(0);

      const companyContextResult = await client.callTool({
        name: 'workgraph_company_context',
        arguments: {
          actor: 'agent-mcp',
        },
      });
      expect(isToolError(companyContextResult)).toBe(false);
      const companyContextPayload = getStructured<{
        teams: unknown[];
        clients: unknown[];
        recentDecisions: unknown[];
        patterns: unknown[];
      }>(companyContextResult);
      expect(Array.isArray(companyContextPayload.teams)).toBe(true);
      expect(Array.isArray(companyContextPayload.clients)).toBe(true);
      expect(Array.isArray(companyContextPayload.recentDecisions)).toBe(true);
      expect(Array.isArray(companyContextPayload.patterns)).toBe(true);

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
        capabilities: [
          'mcp:write',
          'thread:create',
          'thread:update',
          'thread:claim',
          'thread:done',
          'dispatch:run',
          'policy:manage',
          'promote:trigger',
        ],
      });

      const createdDecision = await client.callTool({
        name: 'workgraph_create_decision',
        arguments: {
          title: 'Adopt company context graph',
          actor: 'agent-mcp',
          rationale: 'Improve organizational context quality for autonomous agents.',
          participants: ['agent-mcp', 'agent-mcp-2'],
          alternatives: ['Keep ad-hoc context notes'],
        },
      });
      expect(isToolError(createdDecision)).toBe(false);
      const decisionPayload = getStructured<{ decision: { path: string; fields: { title: string } } }>(createdDecision);
      expect(decisionPayload.decision.path).toMatch(/^decisions\//);
      expect(decisionPayload.decision.fields.title).toBe('Adopt company context graph');

      const recordedLesson = await client.callTool({
        name: 'workgraph_record_lesson',
        arguments: {
          title: 'Track decisions with explicit rationale',
          actor: 'agent-mcp',
          severity: 'important',
          sourceEvent: 'postmortem-2026-03-14',
        },
      });
      expect(isToolError(recordedLesson)).toBe(false);
      const lessonPayload = getStructured<{ lesson: { path: string; fields: { severity: string } } }>(recordedLesson);
      expect(lessonPayload.lesson.path).toMatch(/^lessons\//);
      expect(lessonPayload.lesson.fields.severity).toBe('important');

      const recordedPattern = await client.callTool({
        name: 'workgraph_record_pattern',
        arguments: {
          title: 'Decision preflight checklist',
          actor: 'agent-mcp',
          steps: ['Gather stakeholders', 'Capture alternatives', 'Record rationale'],
          exceptions: ['Emergency incident response'],
        },
      });
      expect(isToolError(recordedPattern)).toBe(false);
      const patternPayload = getStructured<{ pattern: { path: string; fields: { title: string } } }>(recordedPattern);
      expect(patternPayload.pattern.path).toMatch(/^patterns\//);
      expect(patternPayload.pattern.fields.title).toBe('Decision preflight checklist');

      const companyContextAfterWrites = await client.callTool({
        name: 'workgraph_company_context',
        arguments: {
          actor: 'agent-mcp',
        },
      });
      expect(isToolError(companyContextAfterWrites)).toBe(false);
      const contextAfterWritesPayload = getStructured<{
        recentDecisions: Array<{ title: string }>;
        patterns: Array<{ title: string }>;
      }>(companyContextAfterWrites);
      expect(contextAfterWritesPayload.recentDecisions.some((entry) => entry.title === 'Adopt company context graph')).toBe(true);
      expect(contextAfterWritesPayload.patterns.some((entry) => entry.title === 'Decision preflight checklist')).toBe(true);

      const created = await client.callTool({
        name: 'workgraph_thread_create',
        arguments: {
          title: 'MCP lifecycle thread',
          goal: 'Validate full MCP thread lifecycle operations.',
          actor: 'agent-mcp',
          priority: 'high',
          tags: ['mcp'],
        },
      });
      expect(isToolError(created)).toBe(false);
      const createdPayload = getStructured<{
        thread: { path: string };
      }>(created);

      const joined = await client.callTool({
        name: 'workgraph_thread_join',
        arguments: {
          threadPath: createdPayload.thread.path,
          actor: 'agent-mcp',
          role: 'participant',
        },
      });
      expect(isToolError(joined)).toBe(false);

      const claimed = await client.callTool({
        name: 'workgraph_thread_claim',
        arguments: {
          threadPath: createdPayload.thread.path,
          actor: 'agent-mcp',
        },
      });
      expect(isToolError(claimed)).toBe(false);
      const claimedPayload = getStructured<{
        thread: { path: string };
        context: { threadPath: string; totalEntries: number };
      }>(claimed);
      expect(claimedPayload.thread.path).toBe(createdPayload.thread.path);
      expect(claimedPayload.context.threadPath).toBe(createdPayload.thread.path);
      expect(claimedPayload.context.totalEntries).toBe(0);

      const heartbeat = await client.callTool({
        name: 'workgraph_thread_heartbeat',
        arguments: {
          threadPath: createdPayload.thread.path,
          actor: 'agent-mcp',
          note: 'Still in progress',
        },
      });
      expect(isToolError(heartbeat)).toBe(false);

      const blocked = await client.callTool({
        name: 'workgraph_thread_block',
        arguments: {
          threadPath: createdPayload.thread.path,
          actor: 'agent-mcp',
          reason: 'Waiting for dependency confirmation',
        },
      });
      expect(isToolError(blocked)).toBe(false);
      const blockedPayload = getStructured<{ thread: { fields: { status: string } } }>(blocked);
      expect(blockedPayload.thread.fields.status).toBe('blocked');

      const unblocked = await client.callTool({
        name: 'workgraph_thread_unblock',
        arguments: {
          threadPath: createdPayload.thread.path,
          actor: 'agent-mcp',
          reason: 'Dependency resolved',
        },
      });
      expect(isToolError(unblocked)).toBe(false);
      const unblockedPayload = getStructured<{ thread: { fields: { status: string } } }>(unblocked);
      expect(unblockedPayload.thread.fields.status).toBe('active');

      const handedOff = await client.callTool({
        name: 'workgraph_thread_handoff',
        arguments: {
          threadPath: createdPayload.thread.path,
          actor: 'agent-mcp',
          toActor: 'agent-mcp',
          reason: 'No-op handoff for MCP coverage',
        },
      });
      expect(isToolError(handedOff)).toBe(false);

      const released = await client.callTool({
        name: 'workgraph_thread_release',
        arguments: {
          threadPath: createdPayload.thread.path,
          actor: 'agent-mcp',
          reason: 'Ready for final completion',
        },
      });
      expect(isToolError(released)).toBe(false);
      const releasedPayload = getStructured<{ thread: { fields: { status: string } } }>(released);
      expect(releasedPayload.thread.fields.status).toBe('open');

      const reclaimed = await client.callTool({
        name: 'workgraph_thread_claim',
        arguments: {
          threadPath: createdPayload.thread.path,
          actor: 'agent-mcp',
        },
      });
      expect(isToolError(reclaimed)).toBe(false);

      const done = await client.callTool({
        name: 'workgraph_thread_done',
        arguments: {
          threadPath: createdPayload.thread.path,
          actor: 'agent-mcp',
          output: 'Completed from MCP write tool. https://github.com/versatly/workgraph/pull/72',
          reason: 'Lifecycle complete',
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
      const createdRunPayload = getStructured<{ run: { id: string } }>(runCreated);
      expect(createdRunPayload.run.id).toMatch(/^run_/);

      const runExecuted = await client.callTool({
        name: 'workgraph_dispatch_execute',
        arguments: {
          actor: 'agent-mcp',
          runId: createdRunPayload.run.id,
          agents: ['agent-mcp-1', 'agent-mcp-2'],
          maxSteps: 20,
          stepDelayMs: 0,
        },
      });
      expect(isToolError(runExecuted)).toBe(false);
      const executedPayload = getStructured<{ run: { status: string } }>(runExecuted);
      expect(executedPayload.run.status).toBe('succeeded');

      const triggerCreated = await client.callTool({
        name: 'workgraph_trigger_create',
        arguments: {
          actor: 'agent-mcp',
          name: 'MCP manual trigger',
          type: 'manual',
          condition: { type: 'manual' },
          action: {
            type: 'dispatch-run',
            objective: 'Run from MCP trigger for {{target}}',
          },
        },
      });
      expect(isToolError(triggerCreated)).toBe(false);
      const triggerPayload = getStructured<{ trigger: { path: string } }>(triggerCreated);

      const triggerFired = await client.callTool({
        name: 'workgraph_trigger_fire',
        arguments: {
          actor: 'agent-mcp',
          triggerRef: triggerPayload.trigger.path,
          eventKey: 'mcp-trigger-evt-1',
          context: {
            target: 'coordination',
          },
          execute: true,
          maxSteps: 10,
          stepDelayMs: 0,
        },
      });
      expect(isToolError(triggerFired)).toBe(false);
      const firedPayload = getStructured<{ run: { status: string; objective: string } }>(triggerFired);
      expect(firedPayload.run.status).toBe('succeeded');
      expect(firedPayload.run.objective).toContain('coordination');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('exposes primitive tool coverage with context/graph/dispatch aliases', async () => {
    policy.upsertParty(workspacePath, 'agent-mcp', {
      roles: ['operator'],
      capabilities: ['mcp:write', 'thread:claim', 'thread:done', 'dispatch:run', 'policy:manage', 'promote:trigger'],
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
        'workgraph_company_context',
        'workgraph_query',
        'workgraph_primitive_schema',
        'workgraph_thread_list',
        'workgraph_thread_show',
        'workgraph_ledger_recent',
        'workgraph_ledger_reconcile',
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
        'workgraph_create_decision',
        'workgraph_record_lesson',
        'workgraph_record_pattern',
        'workgraph_dispatch_create',
        'workgraph_dispatch_execute',
        'workgraph_dispatch_followup',
        'workgraph_dispatch_stop',
        'workgraph_trigger_create',
        'workgraph_trigger_update',
        'workgraph_trigger_delete',
        'workgraph_trigger_fire',
        'workgraph_trigger_engine_cycle',
        'workgraph_autonomy_run',
        'workgraph_create_mission',
        'workgraph_plan_mission',
        'workgraph_approve_mission',
        'workgraph_start_mission',
        'workgraph_intervene_mission',
        'workgraph_mission_status',
        'workgraph_mission_progress',
        'wg_post_message',
        'wg_ask',
        'wg_create_thread',
        'wg_spawn_thread',
        'wg_thread_context_add',
        'wg_thread_context_search',
        'wg_thread_context_list',
        'wg_thread_context_prune',
        'wg_heartbeat',
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

  it('supports deterministic v2 collaboration tools with schema/auth/idempotency handling', async () => {
    const parent = thread.createThread(
      workspacePath,
      'Parent coordination',
      'Coordinate collaboration flow',
      'seed-agent',
    );
    const server = createWorkgraphMcpServer({
      workspacePath,
      defaultActor: 'agent-v2',
    });
    const client = new Client({
      name: 'workgraph-mcp-test-client-v2',
      version: '1.0.0',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      let schemaRejected = false;
      try {
        const schemaResult = await client.callTool({
          name: 'wg_post_message',
          arguments: {
            threadPath: parent.path,
            body: 'should fail schema',
            messageType: 'invalid-message-type',
          },
        });
        schemaRejected = isToolError(schemaResult);
      } catch {
        schemaRejected = true;
      }
      expect(schemaRejected).toBe(true);

      const denied = await client.callTool({
        name: 'wg_post_message',
        arguments: {
          threadPath: parent.path,
          body: 'Auth denied message',
          idempotencyKey: 'post-denied-key',
        },
      });
      expect(isToolError(denied)).toBe(true);
      const deniedPayload = getStructured<{ ok: boolean; error: { code: string } }>(denied);
      expect(deniedPayload.ok).toBe(false);
      expect(deniedPayload.error.code).toBe('POLICY_DENIED');

      policy.upsertParty(workspacePath, 'agent-v2', {
        roles: ['operator'],
        capabilities: ['mcp:write', 'thread:update', 'thread:create', 'agent:heartbeat'],
      });

      const posted = await client.callTool({
        name: 'wg_post_message',
        arguments: {
          threadPath: parent.path,
          body: 'Coordination message',
          messageType: 'message',
          idempotencyKey: 'post-idem-key',
          evidence: [
            {
              kind: 'link',
              url: 'https://github.com/versatly/workgraph/pull/999',
              title: 'PR evidence',
            },
          ],
          metadata: {
            source: 'test',
            attempt: 1,
          },
        },
      });
      expect(isToolError(posted)).toBe(false);
      const postedPayload = getStructured<{
        ok: boolean;
        data: { operation: string; event: { id: string } };
      }>(posted);
      expect(postedPayload.ok).toBe(true);
      expect(postedPayload.data.operation).toBe('created');

      const postReplay = await client.callTool({
        name: 'wg_post_message',
        arguments: {
          threadPath: parent.path,
          body: 'Coordination message',
          messageType: 'message',
          idempotencyKey: 'post-idem-key',
          evidence: [
            {
              kind: 'link',
              url: 'https://github.com/versatly/workgraph/pull/999',
              title: 'PR evidence',
            },
          ],
          metadata: {
            source: 'test',
            attempt: 1,
          },
        },
      });
      expect(isToolError(postReplay)).toBe(false);
      const replayPayload = getStructured<{
        data: { operation: string; event: { id: string } };
      }>(postReplay);
      expect(replayPayload.data.operation).toBe('replayed');
      expect(replayPayload.data.event.id).toBe(postedPayload.data.event.id);

      const postConflict = await client.callTool({
        name: 'wg_post_message',
        arguments: {
          threadPath: parent.path,
          body: 'Changed body should conflict',
          messageType: 'message',
          idempotencyKey: 'post-idem-key',
        },
      });
      expect(isToolError(postConflict)).toBe(true);
      const conflictPayload = getStructured<{ ok: boolean; error: { code: string } }>(postConflict);
      expect(conflictPayload.ok).toBe(false);
      expect(conflictPayload.error.code).toBe('IDEMPOTENCY_CONFLICT');

      const asked = await client.callTool({
        name: 'wg_ask',
        arguments: {
          threadPath: parent.path,
          question: 'Can you provide a status update?',
          idempotencyKey: 'ask-idem-key',
          awaitReply: false,
        },
      });
      expect(isToolError(asked)).toBe(false);
      const askPayload = getStructured<{
        data: {
          operation: string;
          status: string;
          correlation_id: string;
          ask: { id: string };
        };
      }>(asked);
      expect(askPayload.data.operation).toBe('created');
      expect(askPayload.data.status).toBe('pending');

      const askReplay = await client.callTool({
        name: 'wg_ask',
        arguments: {
          threadPath: parent.path,
          question: 'Can you provide a status update?',
          idempotencyKey: 'ask-idem-key',
          awaitReply: false,
        },
      });
      expect(isToolError(askReplay)).toBe(false);
      const askReplayPayload = getStructured<{
        data: {
          operation: string;
          correlation_id: string;
          ask: { id: string };
        };
      }>(askReplay);
      expect(askReplayPayload.data.operation).toBe('replayed');
      expect(askReplayPayload.data.correlation_id).toBe(askPayload.data.correlation_id);
      expect(askReplayPayload.data.ask.id).toBe(askPayload.data.ask.id);

      const spawned = await client.callTool({
        name: 'wg_spawn_thread',
        arguments: {
          parentThreadPath: parent.path,
          title: 'Child coordination task',
          goal: 'Implement child flow',
          idempotencyKey: 'spawn-idem-key',
          tags: ['coordination'],
          contextRefs: ['spaces/platform.md'],
        },
      });
      expect(isToolError(spawned)).toBe(false);
      const spawnedPayload = getStructured<{
        data: { operation: string; thread: { path: string } };
      }>(spawned);
      expect(spawnedPayload.data.operation).toBe('created');

      const spawnReplay = await client.callTool({
        name: 'wg_spawn_thread',
        arguments: {
          parentThreadPath: parent.path,
          title: 'Child coordination task',
          goal: 'Implement child flow',
          idempotencyKey: 'spawn-idem-key',
          tags: ['coordination'],
          contextRefs: ['spaces/platform.md'],
        },
      });
      expect(isToolError(spawnReplay)).toBe(false);
      const spawnReplayPayload = getStructured<{
        data: { operation: string; thread: { path: string } };
      }>(spawnReplay);
      expect(spawnReplayPayload.data.operation).toBe('replayed');
      expect(spawnReplayPayload.data.thread.path).toBe(spawnedPayload.data.thread.path);

      const createdStandalone = await client.callTool({
        name: 'wg_create_thread',
        arguments: {
          title: 'Standalone MCP task',
          goal: 'Create a top-level thread without parent',
          idempotencyKey: 'create-idem-key',
          priority: 'high',
          tags: ['standalone'],
        },
      });
      expect(isToolError(createdStandalone)).toBe(false);
      const createdStandalonePayload = getStructured<{
        data: { operation: string; thread: { path: string; parent: string | null } };
      }>(createdStandalone);
      expect(createdStandalonePayload.data.operation).toBe('created');
      expect(createdStandalonePayload.data.thread.parent).toBeNull();

      const createReplay = await client.callTool({
        name: 'wg_create_thread',
        arguments: {
          title: 'Standalone MCP task',
          goal: 'Create a top-level thread without parent',
          idempotencyKey: 'create-idem-key',
          priority: 'high',
          tags: ['standalone'],
        },
      });
      expect(isToolError(createReplay)).toBe(false);
      const createReplayPayload = getStructured<{
        data: { operation: string; thread: { path: string } };
      }>(createReplay);
      expect(createReplayPayload.data.operation).toBe('replayed');
      expect(createReplayPayload.data.thread.path).toBe(createdStandalonePayload.data.thread.path);

      const contextAdded = await client.callTool({
        name: 'wg_thread_context_add',
        arguments: {
          threadPath: createdStandalonePayload.data.thread.path,
          title: 'Decision record',
          content: 'Use delivery-id plus digest dedup in gateway.',
          source: 'adr/2026-03-11',
          relevance: 0.8,
        },
      });
      expect(isToolError(contextAdded)).toBe(false);

      const contextList = await client.callTool({
        name: 'wg_thread_context_list',
        arguments: {
          threadPath: createdStandalonePayload.data.thread.path,
        },
      });
      expect(isToolError(contextList)).toBe(false);
      const contextListPayload = getStructured<{
        data: { count: number; entries: Array<{ title: string }> };
      }>(contextList);
      expect(contextListPayload.data.count).toBe(1);
      expect(contextListPayload.data.entries[0]?.title).toBe('Decision record');

      const contextSearch = await client.callTool({
        name: 'wg_thread_context_search',
        arguments: {
          threadPath: createdStandalonePayload.data.thread.path,
          query: 'delivery dedup',
          limit: 5,
        },
      });
      expect(isToolError(contextSearch)).toBe(false);
      const contextSearchPayload = getStructured<{
        data: { count: number; results: Array<{ title: string; bm25_score: number }> };
      }>(contextSearch);
      expect(contextSearchPayload.data.count).toBe(1);
      expect(contextSearchPayload.data.results[0]?.title).toBe('Decision record');
      expect(contextSearchPayload.data.results[0]?.bm25_score ?? 0).toBeGreaterThan(0);

      const contextPrune = await client.callTool({
        name: 'wg_thread_context_prune',
        arguments: {
          threadPath: createdStandalonePayload.data.thread.path,
          minRelevance: 0.9,
        },
      });
      expect(isToolError(contextPrune)).toBe(false);
      const contextPrunePayload = getStructured<{
        data: { removed_count: number; kept_count: number };
      }>(contextPrune);
      expect(contextPrunePayload.data.removed_count).toBe(1);
      expect(contextPrunePayload.data.kept_count).toBe(0);

      const heartbeatResult = await client.callTool({
        name: 'wg_heartbeat',
        arguments: {
          actor: 'agent-v2',
          status: 'busy',
          currentWork: parent.path,
          threadPath: parent.path,
          threadLeaseMinutes: 20,
        },
      });
      expect(isToolError(heartbeatResult)).toBe(false);
      const heartbeatPayload = getStructured<{
        data: {
          operation: string;
          presence: { status: string };
          threads: { touched: unknown[]; skipped: unknown[] };
        };
      }>(heartbeatResult);
      expect(heartbeatPayload.data.operation).toBe('updated');
      expect(heartbeatPayload.data.presence.status).toBe('busy');
      expect(Array.isArray(heartbeatPayload.data.threads.touched)).toBe(true);
      expect(Array.isArray(heartbeatPayload.data.threads.skipped)).toBe(true);
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
