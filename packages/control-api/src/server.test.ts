import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  agent as agentModule,
  policy as policyModule,
  store as storeModule,
  thread as threadModule,
  workspace as workspaceModule,
} from '@versatly/workgraph-kernel';
import { startWorkgraphServer } from './server.js';

const agent = agentModule;
const policy = policyModule;
const store = storeModule;
const thread = threadModule;
const workspace = workspaceModule;

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-server-http-'));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('workgraph server REST API', () => {
  it('serves /health endpoint', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const response = await fetch(`${handle.baseUrl}/health`);
      const body = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.endpointPath).toBe('/mcp');
    } finally {
      await handle.close();
    }
  });

  it('returns workspace status from /api/status', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      thread.createThread(workspacePath, 'Status thread', 'Status goal', 'seed');
      const response = await fetch(`${handle.baseUrl}/api/status`);
      const body = await response.json() as {
        ok: boolean;
        status: { threads: { total: number } };
      };
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.status.threads.total).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it('rejects missing token for protected REST endpoints', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
      bearerToken: 'secret',
    });
    try {
      const response = await fetch(`${handle.baseUrl}/api/status`);
      const body = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(401);
      expect(body.error).toBe('Missing bearer token.');
    } finally {
      await handle.close();
    }
  });

  it('rejects invalid token for protected REST endpoints', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
      bearerToken: 'secret',
    });
    try {
      const response = await fetch(`${handle.baseUrl}/api/status`, {
        headers: {
          authorization: 'Bearer wrong',
        },
      });
      const body = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(403);
      expect(body.error).toBe('Invalid bearer token.');
    } finally {
      await handle.close();
    }
  });

  it('accepts valid token for protected REST endpoints', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
      bearerToken: 'secret',
    });
    try {
      const response = await fetch(`${handle.baseUrl}/api/status`, {
        headers: {
          authorization: 'Bearer secret',
        },
      });
      expect(response.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('lists threads with filters and limit', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      thread.createThread(workspacePath, 'Open backend', 'Goal', 'seed', { space: 'spaces/backend' });
      const active = thread.createThread(workspacePath, 'Active backend', 'Goal', 'seed', { space: 'spaces/backend' });
      thread.claim(workspacePath, active.path, 'agent-a');
      thread.createThread(workspacePath, 'Open frontend', 'Goal', 'seed', { space: 'spaces/frontend' });

      const response = await fetch(`${handle.baseUrl}/api/threads?status=open&space=spaces/backend&limit=1`);
      const body = await response.json() as {
        ok: boolean;
        count: number;
        threads: Array<{ path: string; ready: boolean; fields: { status: string } }>;
      };
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.count).toBe(1);
      expect(body.threads[0].path).toBe('threads/open-backend.md');
      expect(body.threads[0].fields.status).toBe('open');
      expect(typeof body.threads[0].ready).toBe('boolean');
    } finally {
      await handle.close();
    }
  });

  it('returns one thread by slug id', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const created = thread.createThread(workspacePath, 'Lookup thread', 'Goal', 'seed');
      const response = await fetch(`${handle.baseUrl}/api/threads/lookup-thread`);
      const body = await response.json() as { ok: boolean; thread: { path: string } };
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.thread.path).toBe(created.path);
    } finally {
      await handle.close();
    }
  });

  it('returns one thread by encoded path id', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const created = thread.createThread(workspacePath, 'Lookup encoded', 'Goal', 'seed');
      const encodedPath = encodeURIComponent(created.path);
      const response = await fetch(`${handle.baseUrl}/api/threads/${encodedPath}`);
      const body = await response.json() as { ok: boolean; thread: { path: string } };
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.thread.path).toBe(created.path);
    } finally {
      await handle.close();
    }
  });

  it('returns 404 when thread is missing', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const response = await fetch(`${handle.baseUrl}/api/threads/does-not-exist`);
      expect(response.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it('creates threads via POST /api/threads', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
      defaultActor: 'api-default',
    });
    try {
      const response = await fetch(`${handle.baseUrl}/api/threads`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: 'From API',
          goal: 'Ship from REST',
          tags: ['api', 'test'],
        }),
      });
      const body = await response.json() as { ok: boolean; thread: { path: string } };
      expect(response.status).toBe(201);
      expect(body.ok).toBe(true);
      expect(body.thread.path).toBe('threads/from-api.md');
      const persisted = store.read(workspacePath, body.thread.path);
      expect(persisted).not.toBeNull();
    } finally {
      await handle.close();
    }
  });

  it('creates intake-style threads from observation', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const response = await fetch(`${handle.baseUrl}/api/threads`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          observation: 'Observed deployment regression in edge nodes',
        }),
      });
      const body = await response.json() as { ok: boolean; thread: { path: string } };
      expect(response.status).toBe(201);
      expect(body.ok).toBe(true);
      expect(body.thread.path).toBe('threads/observed-deployment-regression-in-edge-nodes.md');
    } finally {
      await handle.close();
    }
  });

  it('updates thread status via PATCH /api/threads/:id', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
      defaultActor: 'api-default',
    });
    try {
      const created = thread.createThread(workspacePath, 'Patch me', 'Goal', 'seed');

      const claimResponse = await fetch(`${handle.baseUrl}/api/threads/patch-me`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          status: 'active',
          actor: 'api-worker',
        }),
      });
      const claimBody = await claimResponse.json() as { ok: boolean; thread: { fields: { status: string; owner: string } } };
      expect(claimResponse.status).toBe(200);
      expect(claimBody.ok).toBe(true);
      expect(claimBody.thread.fields.status).toBe('active');
      expect(claimBody.thread.fields.owner).toBe('api-worker');

      const doneResponse = await fetch(`${handle.baseUrl}/api/threads/${encodeURIComponent(created.path)}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          status: 'done',
          actor: 'api-worker',
          output: 'Done from REST https://github.com/Versatly/workgraph/pull/1',
        }),
      });
      const doneBody = await doneResponse.json() as { ok: boolean; thread: { fields: { status: string } } };
      expect(doneResponse.status).toBe(200);
      expect(doneBody.ok).toBe(true);
      expect(doneBody.thread.fields.status).toBe('done');

      const reopenResponse = await fetch(`${handle.baseUrl}/api/threads/patch-me`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          status: 'open',
          actor: 'api-worker',
          reason: 'Needs follow-up',
        }),
      });
      const reopenBody = await reopenResponse.json() as { ok: boolean; thread: { fields: { status: string } } };
      expect(reopenResponse.status).toBe(200);
      expect(reopenBody.ok).toBe(true);
      expect(reopenBody.thread.fields.status).toBe('open');
    } finally {
      await handle.close();
    }
  });

  it('returns recent ledger entries with a limit', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const first = thread.createThread(workspacePath, 'Ledger one', 'Goal', 'seed');
      const second = thread.createThread(workspacePath, 'Ledger two', 'Goal', 'seed');
      thread.claim(workspacePath, first.path, 'agent-a');
      thread.claim(workspacePath, second.path, 'agent-b');

      const response = await fetch(`${handle.baseUrl}/api/ledger?limit=2`);
      const body = await response.json() as {
        ok: boolean;
        count: number;
        entries: Array<{ target: string }>;
      };
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.count).toBe(2);
      expect(body.entries.length).toBe(2);
    } finally {
      await handle.close();
    }
  });

  it('replays collaboration ask/reply events across SSE reconnects', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    const client = new Client({
      name: 'workgraph-collaboration-reconnect-client',
      version: '1.0.0',
    });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url));
    await client.connect(transport);
    const streamOne = await openSseStream(`${handle.baseUrl}/api/events`);
    try {
      policy.upsertParty(workspacePath, 'collab-agent', {
        roles: ['operator'],
        capabilities: ['mcp:write', 'thread:update', 'thread:create', 'agent:heartbeat'],
      });
      const parent = thread.createThread(
        workspacePath,
        'SSE reconnect parent',
        'Validate collaboration replay across reconnect',
        'seed',
      );
      const correlationId = 'corr-reconnect-test';
      const askResult = await client.callTool({
        name: 'wg_ask',
        arguments: {
          actor: 'collab-agent',
          threadPath: parent.path,
          question: 'Can you confirm deployment status?',
          correlationId,
          idempotencyKey: 'ask-reconnect-idem',
          awaitReply: false,
        },
      });
      expect(isToolError(askResult)).toBe(false);
      const askPayload = getStructured<{
        ok: boolean;
        data: { status: string; correlation_id: string };
      }>(askResult);
      expect(askPayload.ok).toBe(true);
      expect(askPayload.data.status).toBe('pending');
      expect(askPayload.data.correlation_id).toBe(correlationId);

      const askEvent = await waitForSseEvent(
        streamOne.reader,
        (event) => event.type === 'collaboration.ask',
        4_000,
      );
      expect(askEvent.id).toBeTruthy();
      await streamOne.close();

      const replyResult = await client.callTool({
        name: 'wg_post_message',
        arguments: {
          actor: 'collab-agent',
          threadPath: parent.path,
          body: 'Deployment confirmed healthy.',
          messageType: 'reply',
          replyToCorrelationId: correlationId,
          idempotencyKey: 'reply-reconnect-idem',
        },
      });
      expect(isToolError(replyResult)).toBe(false);

      const streamTwo = await openSseStream(`${handle.baseUrl}/api/events`, askEvent.id);
      try {
        const replayedReply = await waitForSseEvent(
          streamTwo.reader,
          (event) => event.type === 'collaboration.reply',
          4_000,
        );
        expect(replayedReply.id).toBeTruthy();
        const replyData = toRecord(replayedReply.data);
        const replyFields = toRecord(replyData?.fields);
        expect(replyFields?.reply_to).toBe(correlationId);
      } finally {
        await streamTwo.close();
      }

      const polledAsk = await client.callTool({
        name: 'wg_ask',
        arguments: {
          actor: 'collab-agent',
          threadPath: parent.path,
          question: 'Can you confirm deployment status?',
          correlationId,
          idempotencyKey: 'ask-reconnect-idem',
          awaitReply: true,
          timeoutMs: 1_000,
          pollIntervalMs: 50,
        },
      });
      expect(isToolError(polledAsk)).toBe(false);
      const polledPayload = getStructured<{
        ok: boolean;
        data: {
          operation: string;
          status: string;
          reply: { id: string } | null;
        };
      }>(polledAsk);
      expect(polledPayload.ok).toBe(true);
      expect(polledPayload.data.operation).toBe('replayed');
      expect(polledPayload.data.status).toBe('answered');
      expect(polledPayload.data.reply?.id).toBeTruthy();
    } finally {
      await streamOne.close();
      await client.close();
      await handle.close();
    }
  });

  it('enforces strict credential identity for mutating REST endpoints', async () => {
    const init = workspace.initWorkspace(workspacePath, { createReadme: false, createBases: false });
    const registration = agent.registerAgent(workspacePath, 'api-admin', {
      token: init.bootstrapTrustToken,
      capabilities: ['thread:create', 'thread:update', 'thread:complete'],
    });
    expect(registration.apiKey).toBeDefined();

    const serverConfigPath = path.join(workspacePath, '.workgraph', 'server.json');
    const serverConfig = JSON.parse(fs.readFileSync(serverConfigPath, 'utf-8')) as Record<string, unknown>;
    serverConfig.auth = {
      mode: 'strict',
      allowUnauthenticatedFallback: false,
    };
    fs.writeFileSync(serverConfigPath, `${JSON.stringify(serverConfig, null, 2)}\n`, 'utf-8');

    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
      defaultActor: 'system',
    });
    try {
      const unauthorized = await fetch(`${handle.baseUrl}/api/threads`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Strict denied',
          goal: 'Missing credential should fail',
        }),
      });
      expect(unauthorized.status).toBe(403);

      const spoofed = await fetch(`${handle.baseUrl}/api/threads`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${registration.apiKey}`,
        },
        body: JSON.stringify({
          title: 'Strict spoofed',
          goal: 'Credential actor mismatch should fail',
          actor: 'spoofed-actor',
        }),
      });
      expect(spoofed.status).toBe(403);

      const authorized = await fetch(`${handle.baseUrl}/api/threads`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${registration.apiKey}`,
        },
        body: JSON.stringify({
          title: 'Strict allowed',
          goal: 'Valid credential actor should pass',
        }),
      });
      expect(authorized.status).toBe(201);
      const body = await authorized.json() as { ok: boolean; thread: { path: string } };
      expect(body.ok).toBe(true);
      expect(body.thread.path).toBe('threads/strict-allowed.md');
    } finally {
      await handle.close();
    }
  });
});

function getStructured<T>(result: unknown): T {
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

async function openSseStream(
  url: string,
  lastEventId?: string,
): Promise<{
  reader: ReadableStreamDefaultReader<Uint8Array>;
  close: () => Promise<void>;
}> {
  const response = await fetch(url, {
    headers: {
      ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
    },
  });
  if (response.status !== 200) {
    throw new Error(`Unexpected SSE status: ${response.status}`);
  }
  if (!response.body) {
    throw new Error('Expected SSE response body stream.');
  }
  const reader = response.body.getReader();
  return {
    reader,
    close: async () => {
      try {
        await reader.cancel();
      } catch {
        // no-op
      }
    },
  };
}

async function waitForSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (event: { id?: string; type: string; data: unknown }) => boolean,
  timeoutMs: number,
): Promise<{ id?: string; type: string; data: unknown }> {
  const deadline = Date.now() + timeoutMs;
  const decoder = new TextDecoder();
  let buffer = '';
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Timed out waiting for SSE event.')), remaining);
      }),
    ]);
    if (chunk.done) {
      break;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    let separator = buffer.indexOf('\n\n');
    while (separator !== -1) {
      const rawEvent = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const parsed = parseSseEvent(rawEvent);
      if (parsed && predicate(parsed)) {
        return parsed;
      }
      separator = buffer.indexOf('\n\n');
    }
  }
  throw new Error('Timed out waiting for matching SSE event.');
}

function parseSseEvent(rawEvent: string): { id?: string; type: string; data: unknown } | null {
  const lines = rawEvent
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith(':'));
  if (lines.length === 0) return null;
  let id: string | undefined;
  let type = 'message';
  let dataLine = '';
  for (const line of lines) {
    if (line.startsWith('id:')) {
      id = line.slice('id:'.length).trim();
    } else if (line.startsWith('event:')) {
      type = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLine += line.slice('data:'.length).trim();
    }
  }
  if (!dataLine) return null;
  try {
    return {
      ...(id ? { id } : {}),
      type,
      data: JSON.parse(dataLine),
    };
  } catch {
    return null;
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
