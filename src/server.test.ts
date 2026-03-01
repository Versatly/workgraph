import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from './store.js';
import * as thread from './thread.js';
import { startWorkgraphServer } from './server.js';

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
});
