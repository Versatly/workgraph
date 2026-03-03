import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as ledger from './ledger.js';
import type { LedgerEntry } from './types.js';

const DEFAULT_SSE_PATH = '/events';
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_HEARTBEAT_MS = 15_000;

export interface WorkgraphEventStreamOptions {
  workspacePath: string;
  host?: string;
  port?: number;
  path?: string;
  pollIntervalMs?: number;
  heartbeatMs?: number;
}

export interface WorkgraphSseEvent {
  type:
    | 'primitive.created'
    | 'primitive.updated'
    | 'primitive.deleted'
    | 'thread.claimed'
    | 'thread.completed'
    | 'trigger.fired'
    | 'collaboration.message'
    | 'collaboration.ask'
    | 'collaboration.reply'
    | 'collaboration.heartbeat';
  primitive: string;
  timestamp: string;
  actor: string;
  target: string;
  primitiveType?: string;
}

export interface WorkgraphEventStreamHandle {
  url: string;
  close: () => Promise<void>;
  emitManualEvent: (event: WorkgraphSseEvent) => void;
}

export async function startWorkgraphEventStream(
  options: WorkgraphEventStreamOptions,
): Promise<WorkgraphEventStreamHandle> {
  const routePath = normalizeSsePath(options.path);
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  let knownLedgerEntries = ledger.readAll(options.workspacePath).length;
  const clients = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID',
      });
      res.end();
      return;
    }

    if (req.method !== 'GET' || !req.url) {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (requestUrl.pathname !== routePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.write(': workgraph-sse-connected\n\n');
    clients.add(res);
    req.on('close', () => {
      clients.delete(res);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve SSE server address.');
  }
  const resolvedAddress = address as AddressInfo;
  const url = `http://${host}:${resolvedAddress.port}${routePath}`;

  const emit = (event: WorkgraphSseEvent): void => {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      try {
        client.write(`event: ${event.type}\n`);
        client.write(`data: ${payload}\n\n`);
      } catch {
        clients.delete(client);
      }
    }
  };

  const pollTimer = setInterval(() => {
    const entries = ledger.readAll(options.workspacePath);
    if (entries.length < knownLedgerEntries) {
      knownLedgerEntries = 0;
    }
    if (entries.length === knownLedgerEntries) return;
    const delta = entries.slice(knownLedgerEntries);
    knownLedgerEntries = entries.length;
    for (const entry of delta) {
      for (const event of mapLedgerEntryToSseEvents(entry)) {
        emit(event);
      }
    }
  }, Math.max(25, pollIntervalMs));
  pollTimer.unref();

  const heartbeatTimer = setInterval(() => {
    for (const client of clients) {
      try {
        client.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        clients.delete(client);
      }
    }
  }, Math.max(1_000, heartbeatMs));
  heartbeatTimer.unref();

  const close = async (): Promise<void> => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    for (const client of clients) {
      try {
        client.end();
      } catch {
        // no-op
      }
    }
    clients.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return {
    url,
    close,
    emitManualEvent: emit,
  };
}

export function mapLedgerEntryToSseEvents(entry: LedgerEntry): WorkgraphSseEvent[] {
  const events: WorkgraphSseEvent[] = [];
  const primitive = primitiveSlugFromTarget(entry.target);
  const base = {
    primitive,
    timestamp: entry.ts,
    actor: entry.actor,
    target: entry.target,
    primitiveType: entry.type,
  };

  if (entry.op === 'create' && shouldEmitPrimitiveCrudEvent(entry)) {
    events.push({ ...base, type: 'primitive.created' });
  } else if (entry.op === 'update' && shouldEmitPrimitiveCrudEvent(entry)) {
    events.push({ ...base, type: 'primitive.updated' });
  } else if (entry.op === 'delete' && shouldEmitPrimitiveCrudEvent(entry)) {
    events.push({ ...base, type: 'primitive.deleted' });
  }

  if (entry.type === 'thread' && entry.op === 'claim') {
    events.push({ ...base, type: 'thread.claimed' });
  }

  if (entry.type === 'thread' && entry.op === 'done') {
    events.push({ ...base, type: 'thread.completed' });
  }

  if (entry.type === 'trigger' && entry.op === 'create' && Boolean(entry.data?.fired)) {
    events.push({ ...base, type: 'trigger.fired' });
  }

  if (entry.type === 'conversation' && entry.op === 'update') {
    const conversationEvent = toRecord(entry.data?.conversation_event);
    if (conversationEvent) {
      const eventKind = String(conversationEvent.event_type ?? conversationEvent.kind ?? 'message').trim().toLowerCase();
      events.push({
        ...base,
        type: eventKind === 'ask'
          ? 'collaboration.ask'
          : eventKind === 'reply'
            ? 'collaboration.reply'
            : 'collaboration.message',
      });
    }
  }

  if (
    (entry.type === 'thread' && entry.op === 'heartbeat') ||
    (entry.type === 'presence' && entry.op === 'update' && isPresenceHeartbeat(entry))
  ) {
    events.push({ ...base, type: 'collaboration.heartbeat' });
  }

  return events;
}

function shouldEmitPrimitiveCrudEvent(entry: LedgerEntry): boolean {
  if (entry.target.startsWith('.workgraph/ledger')) return false;
  if (!entry.type) return false;
  return true;
}

function primitiveSlugFromTarget(target: string): string {
  const normalized = String(target).replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;
  if (!basename) return normalized;
  return basename.endsWith('.md') ? basename.slice(0, -3) : basename;
}

function isPresenceHeartbeat(entry: LedgerEntry): boolean {
  const changed = entry.data?.changed;
  if (!Array.isArray(changed)) return false;
  return changed.some((field) => String(field).trim() === 'last_seen');
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeSsePath(pathValue: string | undefined): string {
  if (!pathValue) return DEFAULT_SSE_PATH;
  const trimmed = pathValue.trim();
  if (!trimmed) return DEFAULT_SSE_PATH;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
