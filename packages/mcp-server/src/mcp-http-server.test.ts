import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  agent as agentModule,
  registry as registryModule,
  policy as policyModule,
  thread as threadModule,
  workspace as workspaceModule,
} from '@versatly/workgraph-kernel';
import { startWorkgraphMcpHttpServer } from './mcp-http-server.js';

const agent = agentModule;
const registry = registryModule;
const policy = policyModule;
const thread = threadModule;
const workspace = workspaceModule;

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mcp-http-'));
  const schemaRegistry = registry.loadRegistry(workspacePath);
  registry.saveRegistry(workspacePath, schemaRegistry);
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

  it('accepts wildcard Accept and handles stateless follow-up requests', async () => {
    const handle = await startWorkgraphMcpHttpServer({
      workspacePath,
      defaultActor: 'system',
      host: '127.0.0.1',
      port: 0,
    });

    try {
      const initializeResponse = await fetch(handle.url, {
        method: 'POST',
        headers: {
          accept: '*/*',
          'content-type': 'application/json',
        },
        body: JSON.stringify(createInitializeRequest(1)),
      });
      expect(initializeResponse.status).toBe(200);
      const initializePayload = parseMcpHttpResponse(await initializeResponse.text());
      expect(initializePayload?.result?.serverInfo?.name).toBeTruthy();
      expect(initializeResponse.headers.get('mcp-session-id')).toBeTruthy();

      const toolsResponse = await fetch(handle.url, {
        method: 'POST',
        headers: {
          accept: '*/*',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
      });
      expect(toolsResponse.status).toBe(200);
      const toolsPayload = parseMcpHttpResponse(await toolsResponse.text());
      expect(Array.isArray(toolsPayload?.result?.tools)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('enforces strict credential identity for MCP write tools', async () => {
    const init = workspace.initWorkspace(workspacePath, { createReadme: false, createBases: false });
    const registration = agent.registerAgent(workspacePath, 'mcp-admin', {
      token: init.bootstrapTrustToken,
      capabilities: ['mcp:write', 'thread:claim', 'thread:done', 'dispatch:run', 'agent:approve-registration'],
    });
    expect(registration.apiKey).toBeDefined();
    policy.upsertParty(workspacePath, 'mcp-admin', {
      roles: ['admin'],
      capabilities: ['mcp:write', 'thread:claim', 'thread:done', 'dispatch:run', 'agent:approve-registration'],
    }, {
      actor: 'mcp-admin',
      skipAuthorization: true,
    });
    thread.createThread(workspacePath, 'Strict MCP thread', 'Strict credential enforcement', 'seed');

    const serverConfigPath = path.join(workspacePath, '.workgraph', 'server.json');
    const serverConfig = JSON.parse(fs.readFileSync(serverConfigPath, 'utf-8')) as Record<string, unknown>;
    serverConfig.auth = {
      mode: 'strict',
      allowUnauthenticatedFallback: false,
    };
    fs.writeFileSync(serverConfigPath, `${JSON.stringify(serverConfig, null, 2)}\n`, 'utf-8');

    const handle = await startWorkgraphMcpHttpServer({
      workspacePath,
      defaultActor: 'system',
      host: '127.0.0.1',
      port: 0,
    });
    const authClient = new Client({
      name: 'workgraph-mcp-http-strict-auth-client',
      version: '1.0.0',
    });
    const authTransport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: {
        headers: {
          authorization: `Bearer ${registration.apiKey}`,
        },
      },
    });
    const anonymousClient = new Client({
      name: 'workgraph-mcp-http-strict-anon-client',
      version: '1.0.0',
    });
    const anonymousTransport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: {
        headers: {},
      },
    });

    await authClient.connect(authTransport);
    await anonymousClient.connect(anonymousTransport);
    try {
      const spoofed = await authClient.callTool({
        name: 'workgraph_thread_claim',
        arguments: {
          threadPath: 'threads/strict-mcp-thread.md',
          actor: 'spoofed-actor',
        },
      });
      expect(isToolError(spoofed)).toBe(true);

      const claimed = await authClient.callTool({
        name: 'workgraph_thread_claim',
        arguments: {
          threadPath: 'threads/strict-mcp-thread.md',
          actor: 'mcp-admin',
        },
      });
      expect(isToolError(claimed)).toBe(false);

      const noCredentialWrite = await anonymousClient.callTool({
        name: 'workgraph_dispatch_create',
        arguments: {
          objective: 'strict mode should deny anonymous mutation',
        },
      });
      expect(isToolError(noCredentialWrite)).toBe(true);
    } finally {
      await authClient.close();
      await anonymousClient.close();
      await handle.close();
    }
  });

  it('accepts x-api-key header for MCP auth', async () => {
    const init = workspace.initWorkspace(workspacePath, { createReadme: false, createBases: false });
    const registration = agent.registerAgent(workspacePath, 'mcp-admin', {
      token: init.bootstrapTrustToken,
      capabilities: ['mcp:write', 'thread:claim', 'thread:done', 'dispatch:run', 'agent:approve-registration'],
    });
    expect(registration.apiKey).toBeDefined();
    policy.upsertParty(workspacePath, 'mcp-admin', {
      roles: ['admin'],
      capabilities: ['mcp:write', 'thread:claim', 'thread:done', 'dispatch:run', 'agent:approve-registration'],
    }, {
      actor: 'mcp-admin',
      skipAuthorization: true,
    });
    thread.createThread(workspacePath, 'x-api-key thread', 'x-api-key auth', 'seed');

    const serverConfigPath = path.join(workspacePath, '.workgraph', 'server.json');
    const serverConfig = JSON.parse(fs.readFileSync(serverConfigPath, 'utf-8')) as Record<string, unknown>;
    serverConfig.auth = {
      mode: 'strict',
      allowUnauthenticatedFallback: false,
    };
    fs.writeFileSync(serverConfigPath, `${JSON.stringify(serverConfig, null, 2)}\n`, 'utf-8');

    const handle = await startWorkgraphMcpHttpServer({
      workspacePath,
      defaultActor: 'system',
      host: '127.0.0.1',
      port: 0,
      bearerToken: 'gateway-token',
    });
    const client = new Client({
      name: 'workgraph-mcp-http-x-api-key-client',
      version: '1.0.0',
    });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: {
        headers: {
          'x-api-key': registration.apiKey,
        },
      },
    });

    await client.connect(transport);
    try {
      const claim = await client.callTool({
        name: 'workgraph_thread_claim',
        arguments: {
          threadPath: 'threads/x-api-key-thread.md',
          actor: 'mcp-admin',
        },
      });
      expect(isToolError(claim)).toBe(false);
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

function createInitializeRequest(id: number): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: {
        name: 'workgraph-http-compat-client',
        version: '1.0.0',
      },
    },
  };
}

function parseMcpHttpResponse(body: string): any {
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (!payload) continue;
    return JSON.parse(payload);
  }
  throw new Error(`Unable to parse MCP HTTP response body: ${body}`);
}
