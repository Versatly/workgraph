import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import * as ledger from './ledger.js';
import * as thread from './thread.js';
import { startWorkgraphServer } from './server.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-server-events-'));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('workgraph server reactive dashboard endpoints', () => {
  it('streams SSE events with Last-Event-ID replay semantics', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
      bearerToken: 'secret',
    });

    try {
      const first = thread.createThread(workspacePath, 'Replay first', 'Goal', 'agent-a');
      const second = thread.createThread(workspacePath, 'Replay second', 'Goal', 'agent-a');
      const recentEntries = ledger.recent(workspacePath, 2);
      const firstHash = recentEntries[0]?.hash;
      expect(firstHash).toBeTruthy();

      const client = await connectSse(`${handle.baseUrl}/api/events`, {
        authorization: 'Bearer secret',
        'last-event-id': firstHash!,
      });
      try {
        await waitFor(() =>
          client.text().includes(`"path":"${second.path}"`) &&
          !client.text().includes(`"path":"${first.path}"`),
        );

        thread.claim(workspacePath, second.path, 'agent-live');
        await waitFor(() =>
          client.text().includes('event: thread.claimed') &&
          client.text().includes(`"path":"${second.path}"`) &&
          client.text().includes('"status":"active"'),
        );
      } finally {
        client.close();
      }
    } finally {
      await handle.close();
    }
  });

  it('returns smart lens aggregations with optional space filter', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const blocked = thread.createThread(workspacePath, 'Infra blocked', 'Blocked goal', 'seed', {
        space: 'spaces/infrastructure',
        priority: 'high',
      });
      thread.claim(workspacePath, blocked.path, 'agent-blocked');
      thread.block(workspacePath, blocked.path, 'agent-blocked', 'external/vendor-api', 'Waiting on vendor');

      thread.createThread(workspacePath, 'Infra urgent open', 'Urgent unclaimed', 'seed', {
        space: 'spaces/infrastructure',
        priority: 'urgent',
      });

      const stale = thread.createThread(workspacePath, 'Infra stale active', 'Stale active', 'seed', {
        space: 'spaces/infrastructure',
      });
      thread.claim(workspacePath, stale.path, 'agent-stale');
      setThreadUpdatedTimestamp(workspacePath, stale.path, new Date(Date.now() - (48 * 60 * 60 * 1_000)).toISOString());

      thread.createThread(workspacePath, 'Dependency source', 'Still open dependency', 'seed', {
        space: 'spaces/infrastructure',
      });
      thread.createThread(workspacePath, 'Needs dependency', 'Blocked by [[threads/dependency-source.md]]', 'seed', {
        space: 'spaces/infrastructure',
      });

      const frontendDone = thread.createThread(workspacePath, 'Frontend done', 'Frontend goal', 'seed', {
        space: 'spaces/frontend',
      });
      thread.claim(workspacePath, frontendDone.path, 'agent-frontend');
      thread.done(workspacePath, frontendDone.path, 'agent-frontend', 'Done from test https://github.com/Versatly/workgraph/pull/9');

      const attentionResponse = await fetch(`${handle.baseUrl}/api/lens/attention?space=spaces/infrastructure.md`);
      const attentionBody = await attentionResponse.json() as {
        ok: boolean;
        threads: Array<{ path: string; reason: string }>;
        summary: { blocked: number; stale: number; urgent_unclaimed: number };
      };
      expect(attentionResponse.status).toBe(200);
      expect(attentionBody.ok).toBe(true);
      expect(attentionBody.summary).toEqual({
        blocked: 1,
        stale: 1,
        urgent_unclaimed: 1,
      });
      expect(attentionBody.threads[0]).toMatchObject({
        path: blocked.path,
        reason: 'blocked',
      });
      expect(attentionBody.threads.some((item) => item.reason === 'unresolved_dependencies')).toBe(true);

      const agentsResponse = await fetch(`${handle.baseUrl}/api/lens/agents?space=spaces/infrastructure.md`);
      const agentsBody = await agentsResponse.json() as {
        ok: boolean;
        agents: Array<{ name: string; actionCount: number; claimedThreads: string[]; online: boolean }>;
      };
      expect(agentsResponse.status).toBe(200);
      expect(agentsBody.ok).toBe(true);
      const blockedAgent = agentsBody.agents.find((agent) => agent.name === 'agent-blocked');
      expect(blockedAgent).toBeTruthy();
      expect(blockedAgent!.actionCount).toBeGreaterThan(0);
      expect(blockedAgent!.claimedThreads).toContain(blocked.path);
      expect(typeof blockedAgent!.online).toBe('boolean');

      const spacesResponse = await fetch(`${handle.baseUrl}/api/lens/spaces`);
      const spacesBody = await spacesResponse.json() as {
        ok: boolean;
        spaces: Array<{ name: string; total: number; done: number; progress: number }>;
      };
      expect(spacesResponse.status).toBe(200);
      expect(spacesBody.ok).toBe(true);
      const frontend = spacesBody.spaces.find((space) => space.name === 'spaces/frontend.md');
      expect(frontend).toBeTruthy();
      expect(frontend).toMatchObject({
        total: 1,
        done: 1,
        progress: 100,
      });

      const timelineResponse = await fetch(`${handle.baseUrl}/api/lens/timeline?space=spaces/infrastructure.md`);
      const timelineBody = await timelineResponse.json() as {
        ok: boolean;
        events: Array<{ actor: string; operation: string; threadTitle?: string; changedFields: Record<string, unknown> }>;
      };
      expect(timelineResponse.status).toBe(200);
      expect(timelineBody.ok).toBe(true);
      expect(timelineBody.events.length).toBeGreaterThan(0);
      expect(
        timelineBody.events.some((event) =>
          event.operation === 'block' &&
          event.threadTitle === 'Infra blocked' &&
          event.changedFields.status === 'blocked',
        ),
      ).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('registers/lists/deletes webhooks and dispatches signed matching events', async () => {
    const capture = await startWebhookCaptureServer();
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const registerResponse = await fetch(`${handle.baseUrl}/api/webhooks`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          url: capture.url,
          events: ['thread.*'],
          secret: 'top-secret',
        }),
      });
      const registerBody = await registerResponse.json() as {
        ok: boolean;
        webhook: { id: string; hasSecret: boolean };
      };
      expect(registerResponse.status).toBe(201);
      expect(registerBody.ok).toBe(true);
      expect(registerBody.webhook.hasSecret).toBe(true);

      const listResponse = await fetch(`${handle.baseUrl}/api/webhooks`);
      const listBody = await listResponse.json() as {
        ok: boolean;
        count: number;
        webhooks: Array<{ id: string }>;
      };
      expect(listResponse.status).toBe(200);
      expect(listBody.ok).toBe(true);
      expect(listBody.count).toBe(1);
      expect(listBody.webhooks[0].id).toBe(registerBody.webhook.id);

      thread.createThread(workspacePath, 'Webhook thread', 'Send webhook event', 'agent-webhook');
      await waitFor(() => capture.received.length >= 1);
      const dispatched = capture.received[0];
      expect(dispatched.body).toContain('"type":"thread.created"');
      const expectedSignature = `sha256=${crypto.createHmac('sha256', 'top-secret').update(dispatched.body).digest('hex')}`;
      expect(dispatched.headers['x-workgraph-signature']).toBe(expectedSignature);

      const deleteResponse = await fetch(`${handle.baseUrl}/api/webhooks/${registerBody.webhook.id}`, {
        method: 'DELETE',
      });
      expect(deleteResponse.status).toBe(200);

      const countAfterDelete = capture.received.length;
      thread.createThread(workspacePath, 'Webhook no dispatch', 'Should not dispatch', 'agent-webhook');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(capture.received.length).toBe(countAfterDelete);
    } finally {
      await handle.close();
      await capture.close();
    }
  });
});

async function connectSse(
  url: string,
  headers: Record<string, string> = {},
): Promise<{
  text: () => string;
  close: () => void;
}> {
  const chunks: string[] = [];
  const request = http.request(url, {
    method: 'GET',
    headers,
  });
  request.end();

  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    request.once('response', resolve);
    request.once('error', reject);
  });
  response.setEncoding('utf8');
  response.on('data', (chunk: string) => {
    chunks.push(chunk);
  });

  return {
    text: () => chunks.join(''),
    close: () => {
      request.destroy();
      response.destroy();
    },
  };
}

async function startWebhookCaptureServer(): Promise<{
  url: string;
  received: Array<{ headers: http.IncomingHttpHeaders; body: string }>;
  close: () => Promise<void>;
}> {
  const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    const bodyChunks: Buffer[] = [];
    req.on('data', (chunk) => bodyChunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      received.push({
        headers: req.headers,
        body: Buffer.concat(bodyChunks).toString('utf8'),
      });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start webhook capture server.');
  }

  return {
    url: `http://127.0.0.1:${address.port}/webhook`,
    received,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function setThreadUpdatedTimestamp(workspaceRoot: string, threadPath: string, timestamp: string): void {
  const absolutePath = path.join(workspaceRoot, threadPath);
  const parsed = matter(fs.readFileSync(absolutePath, 'utf8'));
  const nextData = {
    ...(parsed.data as Record<string, unknown>),
    updated: timestamp,
  };
  fs.writeFileSync(absolutePath, matter.stringify(parsed.content, nextData), 'utf8');
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}
