import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  cursorBridge as cursorBridgeModule,
  policy as policyModule,
  registry as registryModule,
  thread as threadModule,
  transport as transportModule,
  triggerEngine as triggerEngineModule,
  store as storeModule,
} from '@versatly/workgraph-kernel';
import { createWorkgraphMcpServer } from './mcp-server.js';

const cursorBridge = cursorBridgeModule;
const policy = policyModule;
const registry = registryModule;
const store = storeModule;
const thread = threadModule;
const transport = transportModule;
const triggerEngine = triggerEngineModule;

let workspacePath: string;

describe('transport MCP tools', () => {
  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mcp-transport-'));
    const schemaRegistry = registry.loadRegistry(workspacePath);
    registry.saveRegistry(workspacePath, schemaRegistry);
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('lists transport records and replays outbox deliveries', async () => {
    policy.upsertParty(workspacePath, 'agent-mcp', {
      roles: ['operator'],
      capabilities: ['mcp:write', 'dispatch:run'],
    });

    cursorBridge.setupCursorBridge(workspacePath, {
      actor: 'cursor-ops',
      enabled: true,
      allowedEventTypes: ['*'],
      dispatch: {
        adapter: 'cursor-cloud',
        execute: false,
      },
    });
    await cursorBridge.dispatchCursorAutomationEvent(workspacePath, {
      eventType: 'cursor.automation.manual',
      eventId: 'evt-transport-1',
      objective: 'Replay runtime bridge transport',
    });

    const failedEnvelope = transport.createTransportEnvelope({
      direction: 'outbound',
      channel: 'dashboard-webhook',
      topic: 'thread.done',
      source: 'test',
      target: 'https://hooks.example/fail',
      dedupKeys: ['failed-outbox'],
      payload: {
        request: {
          url: 'https://hooks.example/fail',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: '{}',
        },
      },
    });
    const failedOutbox = transport.createTransportOutboxRecord(workspacePath, {
      envelope: failedEnvelope,
      deliveryHandler: 'dashboard-webhook',
      deliveryTarget: 'https://hooks.example/fail',
    });
    transport.markTransportOutboxFailed(workspacePath, failedOutbox.id, {
      message: 'synthetic failure',
    });

    store.create(workspacePath, 'trigger', {
      title: 'Replayable trigger action',
      status: 'active',
      condition: { type: 'event', event: 'thread-complete' },
      action: {
        type: 'dispatch-run',
        objective: 'Replay dispatch {{matched_event_latest_target}}',
      },
      cooldown: 0,
    }, '# Trigger\n', 'system');
    const sourceOne = thread.createThread(workspacePath, 'Replay seed', 'seed event', 'agent-seed');
    thread.claim(workspacePath, sourceOne.path, 'agent-seed');
    thread.done(workspacePath, sourceOne.path, 'agent-seed', 'seed done https://github.com/versatly/workgraph/pull/100');
    triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    const sourceTwo = thread.createThread(workspacePath, 'Replay seed 2', 'second event', 'agent-seed');
    thread.claim(workspacePath, sourceTwo.path, 'agent-seed');
    thread.done(workspacePath, sourceTwo.path, 'agent-seed', 'seed 2 done https://github.com/versatly/workgraph/pull/101');
    triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    const triggerActionOutbox = transport.listTransportOutbox(workspacePath)
      .find((record) => record.deliveryHandler === 'trigger-action');
    expect(triggerActionOutbox).toBeDefined();

    const server = createWorkgraphMcpServer({
      workspacePath,
      defaultActor: 'agent-mcp',
    });
    const client = new Client({
      name: 'workgraph-mcp-transport-client',
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
      expect(toolNames).toContain('wg_transport_outbox_list');
      expect(toolNames).toContain('wg_transport_inbox_list');
      expect(toolNames).toContain('wg_transport_dead_letter_list');
      expect(toolNames).toContain('wg_transport_replay');

      const outbox = await client.callTool({
        name: 'wg_transport_outbox_list',
        arguments: {},
      });
      expect(isToolError(outbox)).toBe(false);
      const outboxPayload = getStructured<{ count: number; records: Array<{ id: string }> }>(outbox);
      expect(outboxPayload.count).toBeGreaterThanOrEqual(2);

      const deadLetter = await client.callTool({
        name: 'wg_transport_dead_letter_list',
        arguments: {},
      });
      expect(isToolError(deadLetter)).toBe(false);
      const deadLetterPayload = getStructured<{ count: number; records: Array<{ sourceRecordId: string }> }>(deadLetter);
      expect(deadLetterPayload.count).toBe(1);
      expect(deadLetterPayload.records[0]?.sourceRecordId).toBe(failedOutbox.id);

      const runtimeBridgeOutbox = transport.listTransportOutbox(workspacePath)
        .find((record) => record.deliveryHandler === 'runtime-bridge');
      expect(runtimeBridgeOutbox).toBeDefined();

      const replayed = await client.callTool({
        name: 'wg_transport_replay',
        arguments: {
          actor: 'agent-mcp',
          recordType: 'outbox',
          id: runtimeBridgeOutbox!.id,
        },
      });
      expect(isToolError(replayed)).toBe(false);
      const replayedPayload = getStructured<{ status: string }>(replayed);
      expect(replayedPayload.status).toBe('replayed');

      const replayedTrigger = await client.callTool({
        name: 'wg_transport_replay',
        arguments: {
          actor: 'agent-mcp',
          recordType: 'outbox',
          id: triggerActionOutbox!.id,
        },
      });
      expect(isToolError(replayedTrigger)).toBe(false);
      const replayedTriggerPayload = getStructured<{ status: string }>(replayedTrigger);
      expect(replayedTriggerPayload.status).toBe('replayed');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function isToolError(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && 'isError' in result && (result as { isError?: boolean }).isError);
}

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
