import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as ledger from './ledger.js';
import {
  mapLedgerEntryToSseEvents,
  startWorkgraphEventStream,
  type WorkgraphSseEvent,
} from './mcp-events.js';
import type { LedgerEntry } from './types.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mcp-events-core-'));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('mcp-events core module', () => {
  it('maps primitive create/update/delete ledger entries to CRUD SSE events', () => {
    const created = mapLedgerEntryToSseEvents(entry({
      op: 'create',
      target: 'threads/alpha.md',
      type: 'thread',
    }));
    expect(created).toEqual([
      expect.objectContaining({
        type: 'primitive.created',
        primitive: 'alpha',
        target: 'threads/alpha.md',
        primitiveType: 'thread',
      }),
    ]);

    const updated = mapLedgerEntryToSseEvents(entry({
      op: 'update',
      target: 'threads/alpha.md',
      type: 'thread',
    }));
    expect(updated).toEqual([
      expect.objectContaining({ type: 'primitive.updated' }),
    ]);

    const deleted = mapLedgerEntryToSseEvents(entry({
      op: 'delete',
      target: 'threads/alpha.md',
      type: 'thread',
    }));
    expect(deleted).toEqual([
      expect.objectContaining({ type: 'primitive.deleted' }),
    ]);
  });

  it('maps thread and trigger specific lifecycle events', () => {
    const claimed = mapLedgerEntryToSseEvents(entry({
      op: 'claim',
      target: 'threads/job.md',
      type: 'thread',
    }));
    expect(claimed).toEqual([
      expect.objectContaining({ type: 'thread.claimed', primitive: 'job' }),
    ]);

    const completed = mapLedgerEntryToSseEvents(entry({
      op: 'done',
      target: 'threads/job.md',
      type: 'thread',
    }));
    expect(completed).toEqual([
      expect.objectContaining({ type: 'thread.completed' }),
    ]);

    const triggerFired = mapLedgerEntryToSseEvents(entry({
      op: 'create',
      target: 'triggers/nightly-rollup.md',
      type: 'trigger',
      data: { fired: true },
    }));
    expect(triggerFired.map((event) => event.type).sort()).toEqual([
      'primitive.created',
      'trigger.fired',
    ]);
  });

  it('suppresses primitive CRUD events for ledger internals and untyped entries', () => {
    const ledgerInternal = mapLedgerEntryToSseEvents(entry({
      op: 'create',
      target: '.workgraph/ledger.jsonl',
      type: 'thread',
    }));
    expect(ledgerInternal).toEqual([]);

    const untyped = mapLedgerEntryToSseEvents(entry({
      op: 'update',
      target: 'threads/alpha.md',
      type: undefined,
    }));
    expect(untyped).toEqual([]);
  });

  it('streams manual events to connected SSE clients', async () => {
    const handle = await startWorkgraphEventStream({
      workspacePath,
      path: '/events-manual',
      pollIntervalMs: 25,
      heartbeatMs: 1_000,
    });
    const client = await connectSse(handle.url);

    try {
      await waitFor(() => client.text().includes('workgraph-sse-connected'));
      const manualEvent: WorkgraphSseEvent = {
        type: 'primitive.created',
        primitive: 'alpha',
        timestamp: new Date().toISOString(),
        actor: 'agent-a',
        target: 'threads/alpha.md',
        primitiveType: 'thread',
      };
      handle.emitManualEvent(manualEvent);

      await waitFor(() =>
        client.text().includes('event: primitive.created') &&
        client.text().includes('"target":"threads/alpha.md"'),
      );
    } finally {
      client.close();
      await handle.close();
    }
  });

  it('polls ledger deltas and emits mapped events', async () => {
    const handle = await startWorkgraphEventStream({
      workspacePath,
      pollIntervalMs: 25,
      heartbeatMs: 1_000,
    });
    const client = await connectSse(handle.url);

    try {
      await waitFor(() => client.text().includes('workgraph-sse-connected'));

      ledger.append(workspacePath, 'agent-claim', 'claim', 'threads/polled.md', 'thread');
      await waitFor(() =>
        client.text().includes('event: thread.claimed') &&
        client.text().includes('"primitive":"polled"'),
      );
    } finally {
      client.close();
      await handle.close();
    }
  });

  it('normalizes custom paths and handles OPTIONS/404/405 HTTP responses', async () => {
    const handle = await startWorkgraphEventStream({
      workspacePath,
      path: 'events-custom',
    });
    try {
      expect(handle.url.endsWith('/events-custom')).toBe(true);

      const optionsResponse = await fetch(handle.url, { method: 'OPTIONS' });
      expect(optionsResponse.status).toBe(204);

      const notFound = await fetch(`${handle.url}-missing`);
      expect(notFound.status).toBe(404);

      const methodNotAllowed = await fetch(handle.url, { method: 'POST' });
      expect(methodNotAllowed.status).toBe(405);
    } finally {
      await handle.close();
    }
  });
});

function entry(input: {
  op: LedgerEntry['op'];
  target: string;
  type?: string;
  data?: Record<string, unknown>;
}): LedgerEntry {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    actor: 'agent-test',
    op: input.op,
    target: input.target,
    ...(input.type ? { type: input.type } : {}),
    ...(input.data ? { data: input.data } : {}),
  };
}

async function connectSse(url: string): Promise<{
  text: () => string;
  close: () => void;
}> {
  const chunks: string[] = [];
  const request = http.get(url);
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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}
