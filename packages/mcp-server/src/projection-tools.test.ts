import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  registry as registryModule,
  thread as threadModule,
} from '@versatly/workgraph-kernel';
import { createWorkgraphMcpServer } from './mcp-server.js';

const registry = registryModule;
const thread = threadModule;

let workspacePath: string;

describe('projection MCP tools', () => {
  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mcp-projections-'));
    registry.saveRegistry(workspacePath, registry.loadRegistry(workspacePath));
    thread.createThread(workspacePath, 'Projection thread', 'projection thread goal', 'agent-projection');
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('exposes projection tools over MCP', async () => {
    const server = createWorkgraphMcpServer({
      workspacePath,
      defaultActor: 'agent-mcp',
    });
    const client = new Client({
      name: 'workgraph-mcp-projection-client',
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
      expect(toolNames).toEqual(expect.arrayContaining([
        'wg_run_health',
        'wg_risk_dashboard',
        'wg_mission_progress_projection',
        'wg_transport_health',
        'wg_federation_status_projection',
        'wg_trigger_health',
        'wg_autonomy_health',
      ]));

      const runHealth = await client.callTool({
        name: 'wg_run_health',
        arguments: {},
      });
      expect(isToolError(runHealth)).toBe(false);
      const runHealthPayload = getStructured<{ scope: string }>(runHealth);
      expect(runHealthPayload.scope).toBe('run');

      const triggerHealth = await client.callTool({
        name: 'wg_trigger_health',
        arguments: {},
      });
      expect(isToolError(triggerHealth)).toBe(false);
      const triggerHealthPayload = getStructured<{ scope: string }>(triggerHealth);
      expect(triggerHealthPayload.scope).toBe('trigger');
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
  return Boolean(result && typeof result === 'object' && 'isError' in result && (result as { isError?: boolean }).isError);
}
