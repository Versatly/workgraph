/**
 * Network gateway for multi-machine Workgraph coordination.
 *
 * This server provides a single-writer control plane over HTTP + SSE so
 * distributed agents can coordinate through one authoritative workspace.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { URL } from 'node:url';
import * as dispatch from './dispatch.js';
import * as ledger from './ledger.js';
import * as lens from './lens.js';
import * as orientation from './orientation.js';
import * as policy from './policy.js';
import * as query from './query.js';
import * as store from './store.js';
import * as thread from './thread.js';

export interface GatewayServerOptions {
  workspacePath: string;
  host?: string;
  port?: number;
  authToken?: string;
  readOnly?: boolean;
  defaultActor?: string;
  eventPollMs?: number;
}

export interface GatewayServerRuntime {
  host: string;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

const DEFAULT_EVENT_LIMIT = 200;
const DEFAULT_EVENT_POLL_MS = 1000;
const DEFAULT_BODY_BYTES_LIMIT = 1_000_000;

type GatewayEnvelope<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export async function startGatewayServer(options: GatewayServerOptions): Promise<GatewayServerRuntime> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 7331;
  const server = http.createServer((req, res) => {
    void handleGatewayRequest(req, res, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address
    ? (address as AddressInfo).port
    : requestedPort;

  return {
    host,
    port: boundPort,
    baseUrl: `http://${host}:${boundPort}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

async function handleGatewayRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: GatewayServerOptions,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = (req.method ?? 'GET').toUpperCase();
    const route = url.pathname;
    if (method === 'OPTIONS') {
      writeCorsHeaders(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (route === '/health') {
      sendJson(res, 200, { ok: true, data: { status: 'ok', ts: new Date().toISOString() } });
      return;
    }

    if (!isAuthorized(req, options.authToken)) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized. Provide Authorization: Bearer <token>.' });
      return;
    }

    if (method === 'GET' && route === '/v1/status') {
      sendOk(res, orientation.statusSnapshot(options.workspacePath));
      return;
    }

    if (method === 'GET' && route === '/v1/brief') {
      const actor = url.searchParams.get('actor') ?? options.defaultActor ?? 'anonymous';
      sendOk(res, orientation.brief(options.workspacePath, actor, {
        recentCount: parsePositiveOptionalInt(url.searchParams.get('recentCount')),
        nextCount: parsePositiveOptionalInt(url.searchParams.get('nextCount')),
      }));
      return;
    }

    if (method === 'GET' && route === '/v1/lenses') {
      sendOk(res, { lenses: lens.listContextLenses() });
      return;
    }

    if (method === 'GET' && route.startsWith('/v1/lens/')) {
      const lensId = decodePathTail(route, '/v1/lens/');
      if (!lensId) {
        sendError(res, 400, 'Lens id is required.');
        return;
      }
      sendOk(res, lens.generateContextLens(options.workspacePath, lensId, {
        actor: url.searchParams.get('actor') ?? options.defaultActor ?? 'anonymous',
        lookbackHours: parsePositiveOptionalNumber(url.searchParams.get('lookbackHours')),
        staleHours: parsePositiveOptionalNumber(url.searchParams.get('staleHours')),
        limit: parsePositiveOptionalInt(url.searchParams.get('limit')),
      }));
      return;
    }

    if (method === 'POST' && route.startsWith('/v1/lens/') && route.endsWith('/materialize')) {
      const lensId = decodePathTail(route.slice(0, -'/materialize'.length), '/v1/lens/');
      const body = await readJsonBody<{
        actor?: string;
        lookbackHours?: number;
        staleHours?: number;
        limit?: number;
        outputPath: string;
      }>(req);
      const actor = body.actor ?? options.defaultActor ?? 'anonymous';
      const gate = checkWriteGate(options, actor, ['lens:materialize', 'gateway:write']);
      if (!gate.allowed) {
        sendError(res, 403, gate.reason);
        return;
      }
      sendOk(res, lens.materializeContextLens(options.workspacePath, lensId, {
        actor,
        lookbackHours: body.lookbackHours,
        staleHours: body.staleHours,
        limit: body.limit,
        outputPath: body.outputPath,
      }));
      return;
    }

    if (method === 'GET' && route === '/v1/query') {
      sendOk(res, {
        results: query.queryPrimitives(options.workspacePath, {
          type: optionalString(url.searchParams.get('type')),
          status: optionalString(url.searchParams.get('status')),
          owner: optionalString(url.searchParams.get('owner')),
          tag: optionalString(url.searchParams.get('tag')),
          text: optionalString(url.searchParams.get('text')),
          pathIncludes: optionalString(url.searchParams.get('pathIncludes')),
          updatedAfter: optionalString(url.searchParams.get('updatedAfter')),
          updatedBefore: optionalString(url.searchParams.get('updatedBefore')),
          createdAfter: optionalString(url.searchParams.get('createdAfter')),
          createdBefore: optionalString(url.searchParams.get('createdBefore')),
          limit: parsePositiveOptionalInt(url.searchParams.get('limit')),
          offset: parseNonNegativeOptionalInt(url.searchParams.get('offset')),
        }),
      });
      return;
    }

    if (method === 'GET' && route === '/v1/threads') {
      const status = optionalString(url.searchParams.get('status'));
      const readyOnly = parseBoolean(url.searchParams.get('readyOnly'));
      const space = optionalString(url.searchParams.get('space'));
      let threads = space
        ? store.threadsInSpace(options.workspacePath, space)
        : store.list(options.workspacePath, 'thread');
      const readySet = new Set(
        (space
          ? thread.listReadyThreadsInSpace(options.workspacePath, space)
          : thread.listReadyThreads(options.workspacePath))
          .map((entry) => entry.path),
      );
      if (status) {
        threads = threads.filter((entry) => String(entry.fields.status ?? '') === status);
      }
      if (readyOnly) {
        threads = threads.filter((entry) => readySet.has(entry.path));
      }
      sendOk(res, {
        threads: threads.map((entry) => ({ ...entry, ready: readySet.has(entry.path) })),
        count: threads.length,
      });
      return;
    }

    if (method === 'POST' && route === '/v1/threads/next-claim') {
      const body = await readJsonBody<{ actor?: string; space?: string }>(req);
      const actor = body.actor ?? options.defaultActor ?? 'anonymous';
      const gate = checkWriteGate(options, actor, ['thread:claim', 'gateway:write']);
      if (!gate.allowed) {
        sendError(res, 403, gate.reason);
        return;
      }
      const claimed = body.space
        ? thread.claimNextReadyInSpace(options.workspacePath, actor, body.space)
        : thread.claimNextReady(options.workspacePath, actor);
      sendOk(res, { thread: claimed, claimed: !!claimed });
      return;
    }

    if (method === 'POST' && route === '/v1/threads/claim') {
      const body = await readJsonBody<{ actor?: string; threadPath: string }>(req);
      const actor = body.actor ?? options.defaultActor ?? 'anonymous';
      const gate = checkWriteGate(options, actor, ['thread:claim', 'gateway:write']);
      if (!gate.allowed) {
        sendError(res, 403, gate.reason);
        return;
      }
      sendOk(res, { thread: thread.claim(options.workspacePath, body.threadPath, actor) });
      return;
    }

    if (method === 'POST' && route === '/v1/threads/done') {
      const body = await readJsonBody<{ actor?: string; threadPath: string; output?: string }>(req);
      const actor = body.actor ?? options.defaultActor ?? 'anonymous';
      const gate = checkWriteGate(options, actor, ['thread:done', 'gateway:write']);
      if (!gate.allowed) {
        sendError(res, 403, gate.reason);
        return;
      }
      sendOk(res, { thread: thread.done(options.workspacePath, body.threadPath, actor, body.output) });
      return;
    }

    if (method === 'POST' && route === '/v1/checkpoints') {
      const body = await readJsonBody<{
        actor?: string;
        summary: string;
        next?: string[];
        blocked?: string[];
        tags?: string[];
      }>(req);
      const actor = body.actor ?? options.defaultActor ?? 'anonymous';
      const gate = checkWriteGate(options, actor, ['checkpoint:create', 'gateway:write']);
      if (!gate.allowed) {
        sendError(res, 403, gate.reason);
        return;
      }
      sendOk(res, {
        checkpoint: orientation.checkpoint(options.workspacePath, actor, body.summary, {
          next: body.next,
          blocked: body.blocked,
          tags: body.tags,
        }),
      });
      return;
    }

    if (method === 'GET' && route === '/v1/dispatch') {
      sendOk(res, {
        runs: dispatch.listRuns(options.workspacePath, {
          status: optionalRunStatus(url.searchParams.get('status')),
          limit: parsePositiveOptionalInt(url.searchParams.get('limit')),
        }),
      });
      return;
    }

    if (method === 'GET' && route.startsWith('/v1/dispatch/')) {
      const runId = decodePathTail(route, '/v1/dispatch/');
      if (!runId) {
        sendError(res, 400, 'Run id is required.');
        return;
      }
      sendOk(res, { run: dispatch.status(options.workspacePath, runId) });
      return;
    }

    if (method === 'POST' && route === '/v1/dispatch/create') {
      const body = await readJsonBody<{
        actor?: string;
        adapter?: string;
        objective: string;
        context?: Record<string, unknown>;
        idempotencyKey?: string;
      }>(req);
      const actor = body.actor ?? options.defaultActor ?? 'anonymous';
      const gate = checkWriteGate(options, actor, ['dispatch:run', 'gateway:write']);
      if (!gate.allowed) {
        sendError(res, 403, gate.reason);
        return;
      }
      sendOk(res, {
        run: dispatch.createRun(options.workspacePath, {
          actor,
          adapter: body.adapter,
          objective: body.objective,
          context: body.context,
          idempotencyKey: body.idempotencyKey,
        }),
      });
      return;
    }

    if (method === 'POST' && route === '/v1/dispatch/execute') {
      const body = await readJsonBody<{
        actor?: string;
        runId: string;
        agents?: string[];
        maxSteps?: number;
        stepDelayMs?: number;
        space?: string;
        createCheckpoint?: boolean;
      }>(req);
      const actor = body.actor ?? options.defaultActor ?? 'anonymous';
      const gate = checkWriteGate(options, actor, ['dispatch:run', 'gateway:write']);
      if (!gate.allowed) {
        sendError(res, 403, gate.reason);
        return;
      }
      sendOk(res, {
        run: await dispatch.executeRun(options.workspacePath, body.runId, {
          actor,
          agents: body.agents,
          maxSteps: body.maxSteps,
          stepDelayMs: body.stepDelayMs,
          space: body.space,
          createCheckpoint: body.createCheckpoint,
        }),
      });
      return;
    }

    if (method === 'POST' && route === '/v1/dispatch/followup') {
      const body = await readJsonBody<{ actor?: string; runId: string; input: string }>(req);
      const actor = body.actor ?? options.defaultActor ?? 'anonymous';
      const gate = checkWriteGate(options, actor, ['dispatch:run', 'gateway:write']);
      if (!gate.allowed) {
        sendError(res, 403, gate.reason);
        return;
      }
      sendOk(res, { run: dispatch.followup(options.workspacePath, body.runId, actor, body.input) });
      return;
    }

    if (method === 'POST' && route === '/v1/dispatch/stop') {
      const body = await readJsonBody<{ actor?: string; runId: string }>(req);
      const actor = body.actor ?? options.defaultActor ?? 'anonymous';
      const gate = checkWriteGate(options, actor, ['dispatch:run', 'gateway:write']);
      if (!gate.allowed) {
        sendError(res, 403, gate.reason);
        return;
      }
      sendOk(res, { run: dispatch.stop(options.workspacePath, body.runId, actor) });
      return;
    }

    if (method === 'GET' && route === '/v1/events') {
      const after = optionalString(url.searchParams.get('after'));
      const limit = parsePositiveOptionalInt(url.searchParams.get('limit')) ?? DEFAULT_EVENT_LIMIT;
      const entries = selectEvents(options.workspacePath, after, limit);
      sendOk(res, {
        entries,
        count: entries.length,
        cursor: entries.length > 0 ? entries[entries.length - 1].ts : after ?? null,
      });
      return;
    }

    if (method === 'GET' && route === '/v1/events/stream') {
      const after = optionalString(url.searchParams.get('after'));
      const limit = parsePositiveOptionalInt(url.searchParams.get('limit')) ?? DEFAULT_EVENT_LIMIT;
      const pollMs = parsePositiveOptionalInt(url.searchParams.get('pollMs'))
        ?? options.eventPollMs
        ?? DEFAULT_EVENT_POLL_MS;
      streamEvents(req, res, options.workspacePath, after, limit, pollMs);
      return;
    }

    sendError(res, 404, `Unknown route: ${method} ${route}`);
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

function streamEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workspacePath: string,
  after: string | undefined,
  limit: number,
  pollMs: number,
): void {
  writeCorsHeaders(res);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let cursor = after;
  res.write(`event: ready\ndata: {"cursor":${JSON.stringify(cursor ?? null)}}\n\n`);

  const flushEvents = () => {
    const entries = selectEvents(workspacePath, cursor, limit);
    for (const entry of entries) {
      res.write(`id: ${entry.ts}\n`);
      res.write(`event: ledger\n`);
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
      cursor = entry.ts;
    }
  };
  flushEvents();

  const timer = setInterval(flushEvents, pollMs);
  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: {}\n\n`);
  }, Math.max(5000, pollMs * 3));

  req.on('close', () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    res.end();
  });
}

function selectEvents(workspacePath: string, after: string | undefined, limit: number) {
  const all = ledger.readAll(workspacePath);
  const filtered = after
    ? all.filter((entry) => entry.ts > after)
    : all;
  if (limit <= 0) return filtered;
  return filtered.slice(-limit);
}

function checkWriteGate(
  options: GatewayServerOptions,
  actor: string,
  requiredCapabilities: string[],
): { allowed: true } | { allowed: false; reason: string } {
  if (options.readOnly) {
    return { allowed: false, reason: 'Gateway is read-only.' };
  }
  if (actor === 'system') {
    return { allowed: true };
  }
  const party = policy.getParty(options.workspacePath, actor);
  if (!party) {
    return {
      allowed: false,
      reason: `Policy gate blocked write: actor "${actor}" is not a registered party.`,
    };
  }
  const hasCapability = requiredCapabilities.some((capability) => party.capabilities.includes(capability));
  if (!hasCapability) {
    return {
      allowed: false,
      reason: `Policy gate blocked write: actor "${actor}" lacks capabilities [${requiredCapabilities.join(', ')}].`,
    };
  }
  return { allowed: true };
}

function isAuthorized(req: http.IncomingMessage, authToken: string | undefined): boolean {
  if (!authToken) return true;
  const headerValue = String(req.headers['x-workgraph-token'] ?? '').trim();
  if (headerValue === authToken) return true;
  const authHeader = String(req.headers.authorization ?? '').trim();
  if (!authHeader.toLowerCase().startsWith('bearer ')) return false;
  const token = authHeader.slice(7).trim();
  return token === authToken;
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += nextChunk.length;
    if (bytes > DEFAULT_BODY_BYTES_LIMIT) {
      throw new Error(`Request body too large (>${DEFAULT_BODY_BYTES_LIMIT} bytes).`);
    }
    chunks.push(nextChunk);
  }
  if (chunks.length === 0) {
    return {} as T;
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error('Invalid JSON request body.');
  }
}

function sendOk<T>(res: http.ServerResponse, data: T): void {
  sendJson(res, 200, { ok: true, data } satisfies GatewayEnvelope<T>);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { ok: false, error: message } satisfies GatewayEnvelope);
}

function sendJson(res: http.ServerResponse, status: number, payload: GatewayEnvelope | { ok: true; data: unknown }): void {
  writeCorsHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function writeCorsHeaders(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Workgraph-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function parsePositiveOptionalInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, received "${value}".`);
  }
  return parsed;
}

function parseNonNegativeOptionalInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected non-negative integer, received "${value}".`);
  }
  return parsed;
}

function parsePositiveOptionalNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive number, received "${value}".`);
  }
  return parsed;
}

function parseBoolean(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function decodePathTail(fullPath: string, prefix: string): string {
  const tail = fullPath.slice(prefix.length).trim();
  return decodeURIComponent(tail.replace(/^\/+/, ''));
}

function optionalString(value: string | null): string | undefined {
  if (value === null) return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function optionalRunStatus(value: string | null): 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | undefined {
  const normalized = optionalString(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'queued' || normalized === 'running' || normalized === 'succeeded' || normalized === 'failed' || normalized === 'cancelled') {
    return normalized;
  }
  throw new Error(`Invalid run status "${normalized}".`);
}
