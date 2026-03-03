import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  agent as agentModule,
  ledger as ledgerModule,
  store as storeModule,
  thread as threadModule,
  workspace as workspaceModule,
} from '@versatly/workgraph-kernel';
import { startWorkgraphServer } from './server.js';

const agent = agentModule;
const ledger = ledgerModule;
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

interface SseEnvelope {
  id: string;
  type: string;
  path: string;
  actor: string;
  fields: Record<string, unknown>;
  ts: string;
}

interface ParsedSseEvent {
  id: string;
  event: string;
  data: SseEnvelope;
}

interface SseReader {
  nextEvent: (timeoutMs?: number) => Promise<ParsedSseEvent>;
  close: () => Promise<void>;
}

async function openSseStream(url: string, init?: RequestInit): Promise<SseReader> {
  const response = await fetch(url, init);
  expect(response.status).toBe(200);
  expect(response.body).toBeDefined();
  return createSseReader(response.body!);
}

function createSseReader(stream: ReadableStream<Uint8Array>): SseReader {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;

  const nextEvent = async (timeoutMs: number = 4_000): Promise<ParsedSseEvent> => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const parsed = tryParseFromBuffer();
      if (parsed) return parsed;
      if (ended) {
        throw new Error('SSE stream ended before next event.');
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error('Timed out waiting for SSE event.');
      }
      const chunk = await withTimeout(reader.read(), remainingMs, 'Timed out waiting for SSE chunk.');
      if (chunk.done) {
        ended = true;
        buffer += decoder.decode();
        continue;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  const close = async () => {
    ended = true;
    try {
      await reader.cancel();
    } catch {
      // no-op
    }
  };

  const tryParseFromBuffer = (): ParsedSseEvent | null => {
    while (true) {
      const boundaryIndex = buffer.indexOf('\n\n');
      if (boundaryIndex < 0) return null;
      const block = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);
      const parsed = parseSseBlock(block);
      if (parsed) return parsed;
    }
  };

  return {
    nextEvent,
    close,
  };
}

function parseSseBlock(block: string): ParsedSseEvent | null {
  const lines = block.split('\n').map((line) => line.replace(/\r$/, ''));
  let id = '';
  let event = '';
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trimStart();
    if (key === 'id') {
      id = value;
      continue;
    }
    if (key === 'event') {
      event = value;
      continue;
    }
    if (key === 'data') {
      dataLines.push(value);
    }
  }
  if (dataLines.length === 0) return null;
  const data = JSON.parse(dataLines.join('\n')) as SseEnvelope;
  return {
    id: id || data.id,
    event: event || data.type,
    data,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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

  it('replays missed thread events from Last-Event-ID with stable ordering and ids', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    const streams: SseReader[] = [];
    try {
      const createdThread = thread.createThread(workspacePath, 'SSE replay', 'Replay goal', 'seed');
      const streamUrl = `${handle.baseUrl}/api/events`
        + `?thread=${encodeURIComponent(createdThread.path)}`
        + '&event=thread.created&event=thread.claimed&event=thread.done';

      const initialStream = await openSseStream(streamUrl);
      streams.push(initialStream);
      const createdEvent = await initialStream.nextEvent();
      expect(createdEvent.event).toBe('thread.created');
      expect(createdEvent.data.id).toBe(createdEvent.id);
      expect(Object.keys(createdEvent.data)).toEqual(['id', 'type', 'path', 'actor', 'fields', 'ts']);
      await initialStream.close();

      thread.claim(workspacePath, createdThread.path, 'worker-a');
      thread.done(
        workspacePath,
        createdThread.path,
        'worker-a',
        'Completed in SSE replay test https://github.com/Versatly/workgraph/pull/1',
      );

      const replayStream = await openSseStream(streamUrl, {
        headers: {
          'last-event-id': createdEvent.id,
        },
      });
      streams.push(replayStream);
      const firstMissed = await replayStream.nextEvent();
      const secondMissed = await replayStream.nextEvent();
      expect(firstMissed.event).toBe('thread.claimed');
      expect(secondMissed.event).toBe('thread.done');
      expect(firstMissed.id).not.toBe(secondMissed.id);
      await replayStream.close();

      const deterministicReplay = await openSseStream(streamUrl, {
        headers: {
          'last-event-id': createdEvent.id,
        },
      });
      streams.push(deterministicReplay);
      const replayAgainFirst = await deterministicReplay.nextEvent();
      const replayAgainSecond = await deterministicReplay.nextEvent();
      expect([replayAgainFirst.id, replayAgainSecond.id]).toEqual([firstMissed.id, secondMissed.id]);
      expect([replayAgainFirst.event, replayAgainSecond.event]).toEqual(['thread.claimed', 'thread.done']);
      await deterministicReplay.close();
    } finally {
      for (const stream of streams) {
        await stream.close();
      }
      await handle.close();
    }
  });

  it('supports primitive filters for conversation, plan-step, and run updates', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    const streams: SseReader[] = [];
    try {
      ledger.append(workspacePath, 'seed', 'update', 'conversations/sse.md', 'conversation', {
        status: 'active',
      });
      ledger.append(workspacePath, 'seed', 'update', 'plan-steps/sse.md', 'plan-step', {
        status: 'active',
      });
      ledger.append(workspacePath, 'seed', 'update', '.workgraph/runs/run_sse', 'run', {
        status: 'running',
      });

      const conversationStream = await openSseStream(
        `${handle.baseUrl}/api/events?primitive=conversation&event=conversation.updated`,
      );
      streams.push(conversationStream);
      const conversationEvent = await conversationStream.nextEvent();
      expect(conversationEvent.event).toBe('conversation.updated');
      expect(conversationEvent.data.path).toBe('conversations/sse.md');
      await conversationStream.close();

      const stepStream = await openSseStream(
        `${handle.baseUrl}/api/events?primitive=plan-step&event=plan-step.updated`,
      );
      streams.push(stepStream);
      const stepEvent = await stepStream.nextEvent();
      expect(stepEvent.event).toBe('plan-step.updated');
      expect(stepEvent.data.path).toBe('plan-steps/sse.md');
      await stepStream.close();

      const runStream = await openSseStream(
        `${handle.baseUrl}/api/events?primitive=run&event=run.updated`,
      );
      streams.push(runStream);
      const runEvent = await runStream.nextEvent();
      expect(runEvent.event).toBe('run.updated');
      expect(runEvent.data.path).toBe('.workgraph/runs/run_sse');
      await runStream.close();
    } finally {
      for (const stream of streams) {
        await stream.close();
      }
      await handle.close();
    }
  });

  it('sends keepalive heartbeat comments for idle SSE streams', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
      sseKeepaliveMs: 100,
    });
    try {
      const response = await fetch(`${handle.baseUrl}/api/events?event=thread.done`);
      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let output = '';
      const deadline = Date.now() + 1_500;
      while (Date.now() < deadline && !output.includes(':keepalive')) {
        const remaining = deadline - Date.now();
        const chunk = await withTimeout(
          reader.read(),
          remaining,
          'Timed out waiting for SSE keepalive comment.',
        );
        if (chunk.done) break;
        output += decoder.decode(chunk.value, { stream: true });
      }
      expect(output.includes(':keepalive')).toBe(true);
      await reader.cancel();
    } finally {
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
