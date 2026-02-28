import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import * as policy from './policy.js';
import * as store from './store.js';
import * as thread from './thread.js';
import * as gateway from './gateway.js';
import * as worker from './worker.js';

let workspacePath: string;
let gatewayRuntime: gateway.GatewayServerRuntime | null;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-gateway-worker-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
  gatewayRuntime = null;
});

afterEach(async () => {
  if (gatewayRuntime) {
    await gatewayRuntime.close();
    gatewayRuntime = null;
  }
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('gateway + worker runtime', () => {
  it('enforces auth token and serves lens/status endpoints', async () => {
    thread.createThread(workspacePath, 'Auth check thread', 'Ensure status endpoint works', 'agent-lead');
    gatewayRuntime = await gateway.startGatewayServer({
      workspacePath,
      port: 0,
      authToken: 'token-123',
    });

    const unauthorized = await fetchJson(`${gatewayRuntime.baseUrl}/v1/status`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body.ok).toBe(false);

    const lenses = await fetchJson(
      `${gatewayRuntime.baseUrl}/v1/lenses`,
      { method: 'GET', headers: authHeaders('token-123') },
    );
    expect(lenses.status).toBe(200);
    expect(lenses.body.ok).toBe(true);
    const ids = (lenses.body.data as { lenses: Array<{ id: string }> }).lenses.map((entry) => entry.id);
    expect(ids).toEqual(['my-work', 'team-risk', 'customer-health', 'exec-brief']);

    const status = await fetchJson(
      `${gatewayRuntime.baseUrl}/v1/status`,
      { method: 'GET', headers: authHeaders('token-123') },
    );
    expect(status.status).toBe(200);
    const statusData = status.body.data as { threads: { total: number } };
    expect(statusData.threads.total).toBe(1);
  });

  it('runs worker loop through gateway and completes dependency chains', async () => {
    policy.upsertParty(workspacePath, 'agent-worker', {
      roles: ['worker'],
      capabilities: ['thread:claim', 'thread:done', 'checkpoint:create', 'gateway:write'],
    });

    const parent = thread.createThread(workspacePath, 'Compile data model', 'Prepare model primitive', 'agent-lead', {
      priority: 'high',
    });
    thread.createThread(workspacePath, 'Wire service handler', 'Integrate model in service', 'agent-lead', {
      deps: [parent.path],
      priority: 'medium',
    });

    gatewayRuntime = await gateway.startGatewayServer({
      workspacePath,
      port: 0,
      authToken: 'token-abc',
    });

    const result = await worker.runGatewayWorkerLoop({
      gatewayUrl: gatewayRuntime.baseUrl,
      actor: 'agent-worker',
      authToken: 'token-abc',
      pollIntervalMs: 1,
      maxCycles: 8,
      checkpointEvery: 1,
    });

    expect(result.claimed).toBeGreaterThanOrEqual(2);
    expect(result.completed).toBeGreaterThanOrEqual(2);
    expect(result.errors).toBe(0);
    expect(store.read(workspacePath, 'threads/compile-data-model.md')?.fields.status).toBe('done');
    expect(store.read(workspacePath, 'threads/wire-service-handler.md')?.fields.status).toBe('done');
    expect(store.list(workspacePath, 'checkpoint').length).toBeGreaterThan(0);

    const events = await fetchJson(
      `${gatewayRuntime.baseUrl}/v1/events?limit=50`,
      { method: 'GET', headers: authHeaders('token-abc') },
    );
    expect(events.status).toBe(200);
    const eventsData = events.body.data as { entries: Array<{ op: string }> };
    expect(eventsData.entries.some((entry) => entry.op === 'done')).toBe(true);
  });

  it('creates and executes dispatch runs via gateway endpoints', async () => {
    policy.upsertParty(workspacePath, 'agent-ops', {
      roles: ['ops'],
      capabilities: ['dispatch:run', 'gateway:write'],
    });

    thread.createThread(workspacePath, 'Dispatch thread one', 'Task one', 'agent-lead', { priority: 'high' });
    thread.createThread(workspacePath, 'Dispatch thread two', 'Task two', 'agent-lead', { priority: 'medium' });

    gatewayRuntime = await gateway.startGatewayServer({
      workspacePath,
      port: 0,
      authToken: 'token-dispatch',
    });

    const created = await fetchJson(
      `${gatewayRuntime.baseUrl}/v1/dispatch/create`,
      {
        method: 'POST',
        headers: authHeaders('token-dispatch'),
        body: JSON.stringify({
          actor: 'agent-ops',
          objective: 'Gateway dispatch e2e',
          adapter: 'cursor-cloud',
        }),
      },
    );
    expect(created.status).toBe(200);
    const runId = (created.body.data as { run: { id: string } }).run.id;

    const executed = await fetchJson(
      `${gatewayRuntime.baseUrl}/v1/dispatch/execute`,
      {
        method: 'POST',
        headers: authHeaders('token-dispatch'),
        body: JSON.stringify({
          actor: 'agent-ops',
          runId,
          agents: ['agent-a', 'agent-b'],
          stepDelayMs: 0,
          maxSteps: 20,
          createCheckpoint: false,
        }),
      },
    );
    expect(executed.status).toBe(200);
    const run = (executed.body.data as { run: { status: string } }).run;
    expect(run.status).toBe('succeeded');
    expect(store.read(workspacePath, 'threads/dispatch-thread-one.md')?.fields.status).toBe('done');
    expect(store.read(workspacePath, 'threads/dispatch-thread-two.md')?.fields.status).toBe('done');
  });
});

function authHeaders(token: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'x-workgraph-token': token,
  };
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: { ok: boolean; data?: unknown; error?: string } }> {
  const response = await fetch(url, init);
  const body = await response.json() as { ok: boolean; data?: unknown; error?: string };
  return {
    status: response.status,
    body,
  };
}
