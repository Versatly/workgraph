import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  federation as federationModule,
  registry as registryModule,
  thread as threadModule,
} from '@versatly/workgraph-kernel';
import { createWorkgraphMcpServer } from './mcp-server.js';

const federation = federationModule;
const registry = registryModule;
const thread = threadModule;

let workspacePath: string;
let remoteWorkspacePath: string;

describe('federation MCP tools', () => {
  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mcp-federation-'));
    remoteWorkspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mcp-federation-remote-'));
    registry.saveRegistry(workspacePath, registry.loadRegistry(workspacePath));
    registry.saveRegistry(remoteWorkspacePath, registry.loadRegistry(remoteWorkspacePath));
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(remoteWorkspacePath, { recursive: true, force: true });
  });

  it('reports federation status, resolves refs, and searches remote workspaces', async () => {
    const localThread = thread.createThread(workspacePath, 'Local thread', 'Coordinate remote work', 'agent-local');
    const remoteThread = thread.createThread(remoteWorkspacePath, 'Remote auth thread', 'Build auth dashboard', 'agent-remote');
    federation.ensureFederationConfig(remoteWorkspacePath);
    federation.addRemoteWorkspace(workspacePath, {
      id: 'remote-main',
      path: remoteWorkspacePath,
      name: 'Remote Main',
    });
    const linked = federation.linkThreadToRemoteWorkspace(
      workspacePath,
      localThread.path,
      'remote-main',
      remoteThread.path,
      'agent-local',
    );

    const server = createWorkgraphMcpServer({
      workspacePath,
      defaultActor: 'agent-mcp',
    });
    const client = new Client({
      name: 'workgraph-mcp-federation-client',
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
      expect(toolNames).toContain('wg_federation_status');
      expect(toolNames).toContain('wg_federation_resolve_ref');
      expect(toolNames).toContain('wg_federation_search');

      const statusResult = await client.callTool({
        name: 'wg_federation_status',
        arguments: {},
      });
      expect(isToolError(statusResult)).toBe(false);
      const statusPayload = getStructured<{ workspace: { workspaceId: string }; remotes: Array<{ remote: { id: string } }> }>(statusResult);
      expect(statusPayload.workspace.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(statusPayload.remotes[0]?.remote.id).toBe('remote-main');

      const resolveResult = await client.callTool({
        name: 'wg_federation_resolve_ref',
        arguments: {
          ref: linked.ref,
        },
      });
      expect(isToolError(resolveResult)).toBe(false);
      const resolvePayload = getStructured<{ source: string; authority: string; instance: { path: string } }>(resolveResult);
      expect(resolvePayload.source).toBe('remote');
      expect(resolvePayload.authority).toBe('remote');
      expect(resolvePayload.instance.path).toBe(remoteThread.path);

      const searchResult = await client.callTool({
        name: 'wg_federation_search',
        arguments: {
          query: 'auth',
          type: 'thread',
          includeLocal: true,
        },
      });
      expect(isToolError(searchResult)).toBe(false);
      const searchPayload = getStructured<{ results: Array<{ workspaceId: string; instance: { path: string } }> }>(searchResult);
      expect(searchPayload.results.some((entry) => entry.workspaceId === 'remote-main' && entry.instance.path === remoteThread.path)).toBe(true);
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
