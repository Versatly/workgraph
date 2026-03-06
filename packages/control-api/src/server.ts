import fs from 'node:fs';
import path from 'node:path';
import {
  auth as authModule,
  environment as environmentModule,
  ledger as ledgerModule,
  orientation as orientationModule,
  store as storeModule,
  thread as threadModule,
  workspace as workspaceModule,
} from '@versatly/workgraph-kernel';
import {
  startWorkgraphMcpHttpServer,
  type WorkgraphMcpHttpServerHandle,
} from '@versatly/workgraph-mcp-server';
import {
  buildAgentsLens,
  buildAttentionLens,
  buildSpacesLens,
  buildTimelineLens,
} from './server-lenses.js';
import {
  createDashboardEventFilter,
  type DashboardEvent,
  listDashboardEventsSince,
  subscribeToDashboardEvents,
  toSsePayload,
} from './server-events.js';
import {
  deleteWebhook,
  dispatchWebhookEvent,
  listWebhooks,
  registerWebhook,
} from './server-webhooks.js';

const ledger = ledgerModule;
const auth = authModule;
const environment = environmentModule;
const orientation = orientationModule;
const store = storeModule;
const thread = threadModule;
const workspace = workspaceModule;

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8787;
const DEFAULT_WORKSPACE = '/data/workspace';
const DEFAULT_ENDPOINT_PATH = '/mcp';
const DEFAULT_LEDGER_LIMIT = 20;
const DEFAULT_THREADS_LIMIT = 100;
const MAX_LEDGER_LIMIT = 500;
const MAX_THREADS_LIMIT = 1_000;
const DEFAULT_SSE_KEEPALIVE_MS = 15_000;
const SSE_RETRY_MS = 3_000;

type LogLevel = 'info' | 'warn' | 'error';

export interface WorkgraphServerOptions {
  workspacePath: string;
  host?: string;
  port?: number;
  bearerToken?: string;
  defaultActor?: string;
  endpointPath?: string;
  sseKeepaliveMs?: number;
  enableSseServer?: boolean;
  enableWebhooks?: boolean;
}

type PrimitiveInstance = any;
type ThreadStatus = string;

export interface WorkgraphServerHandle {
  host: string;
  port: number;
  endpointPath: string;
  baseUrl: string;
  healthUrl: string;
  url: string;
  close: () => Promise<void>;
  workspacePath: string;
  workspaceInitialized: boolean;
}

interface WaitForShutdownOptions {
  onSignal?: (signal: NodeJS.Signals) => void;
  onClosed?: () => void;
}

interface ThreadUpdateRequestBody {
  actor?: unknown;
  status?: unknown;
  output?: unknown;
  reason?: unknown;
  blockedBy?: unknown;
  leaseTtlMinutes?: unknown;
}

interface ThreadCreateRequestBody {
  actor?: unknown;
  title?: unknown;
  goal?: unknown;
  observation?: unknown;
  priority?: unknown;
  deps?: unknown;
  parent?: unknown;
  space?: unknown;
  context_refs?: unknown;
  tags?: unknown;
}

interface WebhookCreateRequestBody {
  actor?: unknown;
  url?: unknown;
  events?: unknown;
  secret?: unknown;
}

export async function startWorkgraphServer(options: WorkgraphServerOptions): Promise<WorkgraphServerHandle> {
  const workspacePath = path.resolve(options.workspacePath);
  const host = readNonEmptyString(options.host) ?? DEFAULT_HOST;
  const port = normalizePort(options.port, DEFAULT_PORT);
  const endpointPath = readNonEmptyString(options.endpointPath) ?? DEFAULT_ENDPOINT_PATH;
  const defaultActor = readNonEmptyString(options.defaultActor) ?? 'anonymous';
  const sseKeepaliveMs = normalizeSseKeepaliveMs(options.sseKeepaliveMs);
  const envInfo = environment.detectEnvironment(workspacePath);
  const enableSseServer = options.enableSseServer
    ?? (envInfo.mode === 'cloud' ? envInfo.featureFlags.sseServer : true);
  const enableWebhooks = options.enableWebhooks
    ?? (envInfo.mode === 'cloud' ? envInfo.featureFlags.webhooks : true);

  const workspaceInitialized = ensureWorkspaceInitialized(workspacePath);
  const unsubscribeWebhookDispatch = enableWebhooks
    ? subscribeToDashboardEvents(workspacePath, (event) => {
      void dispatchWebhookEvent(workspacePath, event);
    })
    : () => {};

  let handle: WorkgraphMcpHttpServerHandle;
  try {
    handle = await startWorkgraphMcpHttpServer({
      workspacePath,
      defaultActor,
      host,
      port,
      endpointPath,
      bearerToken: options.bearerToken,
      onApp: ({ app, bearerAuthMiddleware }) => {
        app.use('/api', bearerAuthMiddleware);
        app.use('/api', (req: any, _res: any, next: () => void) => {
          auth.runWithAuthContext(buildRequestAuthContext(req), () => next());
        });
        registerRestRoutes(app, workspacePath, defaultActor, sseKeepaliveMs, {
          sseServer: enableSseServer,
          webhooks: enableWebhooks,
        });
      },
    });
  } catch (error) {
    unsubscribeWebhookDispatch();
    throw error;
  }

  return {
    ...handle,
    close: async () => {
      unsubscribeWebhookDispatch();
      await handle.close();
    },
    workspacePath,
    workspaceInitialized,
  };
}

export async function waitForShutdown(
  handle: Pick<WorkgraphServerHandle, 'close'>,
  options: WaitForShutdownOptions = {},
): Promise<void> {
  let closing = false;
  await new Promise<void>((resolve, reject) => {
    const stop = async (signal: NodeJS.Signals) => {
      if (closing) return;
      closing = true;
      options.onSignal?.(signal);
      try {
        await handle.close();
        options.onClosed?.();
        cleanup();
        resolve();
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    const onSigterm = () => { void stop('SIGTERM'); };
    const onSigint = () => { void stop('SIGINT'); };
    const cleanup = () => {
      process.off('SIGTERM', onSigterm);
      process.off('SIGINT', onSigint);
    };

    process.on('SIGTERM', onSigterm);
    process.on('SIGINT', onSigint);
  });
}

export async function runWorkgraphServerFromEnv(): Promise<void> {
  const options = loadServerOptionsFromEnv(process.env);
  logJson('info', 'server_starting', {
    workspacePath: options.workspacePath,
    host: options.host,
    port: options.port,
    endpointPath: options.endpointPath,
    auth: options.bearerToken ? 'bearer' : 'none',
    actor: options.defaultActor,
  });

  const handle = await startWorkgraphServer(options);
  if (handle.workspaceInitialized) {
    logJson('info', 'workspace_initialized', { workspacePath: handle.workspacePath });
  }
  logJson('info', 'server_started', {
    workspacePath: handle.workspacePath,
    host: handle.host,
    port: handle.port,
    endpointPath: handle.endpointPath,
    mcpUrl: handle.url,
    healthUrl: handle.healthUrl,
  });

  await waitForShutdown(handle, {
    onSignal: (signal) => {
      logJson('info', 'shutdown_signal', { signal });
    },
    onClosed: () => {
      logJson('info', 'server_stopped', {});
    },
  });
}

export function loadServerOptionsFromEnv(env: NodeJS.ProcessEnv): WorkgraphServerOptions {
  return {
    workspacePath: readNonEmptyString(env.WORKGRAPH_WORKSPACE) ?? DEFAULT_WORKSPACE,
    host: readNonEmptyString(env.WORKGRAPH_HOST) ?? DEFAULT_HOST,
    port: parseOptionalPort(env.WORKGRAPH_PORT) ?? DEFAULT_PORT,
    bearerToken: readNonEmptyString(env.WORKGRAPH_BEARER_TOKEN),
    defaultActor: readNonEmptyString(env.WORKGRAPH_ACTOR) ?? 'anonymous',
    endpointPath: DEFAULT_ENDPOINT_PATH,
    sseKeepaliveMs: parseOptionalPositiveInt(env.WORKGRAPH_SSE_KEEPALIVE_MS, {
      max: 60_000,
    }),
    enableSseServer: readOptionalBoolean(env.WORKGRAPH_FEATURE_SSE_SERVER),
    enableWebhooks: readOptionalBoolean(env.WORKGRAPH_FEATURE_WEBHOOKS),
  };
}

function registerRestRoutes(
  app: any,
  workspacePath: string,
  defaultActor: string,
  sseKeepaliveMs: number,
  featureFlags: {
    sseServer: boolean;
    webhooks: boolean;
  },
): void {
  app.get('/api/events', (req: any, res: any) => {
    try {
      if (!featureFlags.sseServer) {
        res.status(404).json({
          ok: false,
          error: 'SSE event stream is disabled for this deployment mode.',
        });
        return;
      }
      const lastEventId = readNonEmptyString(req.headers?.['last-event-id'])
        ?? readNonEmptyString(req.query?.lastEventId);
      const filter = createDashboardEventFilter({
        eventTypes: readCsvQueryValues(req.query, ['event', 'events']),
        primitiveTypes: readCsvQueryValues(req.query, ['primitive', 'primitiveType']),
        threads: readCsvQueryValues(req.query, ['thread']),
      });
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }
      if (!safeStreamWrite(res, ':connected\n\n')) return;
      if (!safeStreamWrite(res, `retry: ${SSE_RETRY_MS}\n\n`)) return;

      let cleaned = false;
      let streamReady = false;
      let unsubscribe = () => {};
      let keepAlive: NodeJS.Timeout | undefined;
      const queuedLiveEvents: DashboardEvent[] = [];
      let dedupeDuringBootstrap = true;
      const bootstrapDeliveredIds = new Set<string>();

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (keepAlive) {
          clearInterval(keepAlive);
        }
        unsubscribe();
      };

      const emitEvent = (event: DashboardEvent): boolean => {
        if (dedupeDuringBootstrap) {
          if (bootstrapDeliveredIds.has(event.id)) return true;
          bootstrapDeliveredIds.add(event.id);
        }
        if (safeStreamWrite(res, toSsePayload(event))) {
          return true;
        }
        cleanup();
        return false;
      };

      unsubscribe = subscribeToDashboardEvents(workspacePath, (event) => {
        if (!streamReady) {
          queuedLiveEvents.push(event);
          return;
        }
        emitEvent(event);
      }, filter);

      const replay = listDashboardEventsSince(workspacePath, lastEventId, filter);
      for (const event of replay) {
        if (!emitEvent(event)) return;
      }

      while (queuedLiveEvents.length > 0) {
        const event = queuedLiveEvents.shift();
        if (!event) break;
        if (!emitEvent(event)) return;
      }
      streamReady = true;
      dedupeDuringBootstrap = false;
      bootstrapDeliveredIds.clear();

      keepAlive = setInterval(() => {
        if (!safeStreamWrite(res, `:keepalive ${Date.now()}\n\n`)) {
          cleanup();
        }
      }, sseKeepaliveMs);
      if (typeof keepAlive.unref === 'function') {
        keepAlive.unref();
      }

      req.on('close', cleanup);
      req.on('aborted', cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);
    } catch (error) {
      if (!res.headersSent) {
        writeRouteError(res, error);
      }
    }
  });

  app.get('/api/status', (_req: any, res: any) => {
    try {
      const snapshot = orientation.statusSnapshot(workspacePath);
      res.json({
        ok: true,
        status: snapshot,
      });
    } catch (error) {
      writeRouteError(res, error);
    }
  });

  app.get('/api/threads', (req: any, res: any) => {
    try {
      const status = readNonEmptyString(req.query?.status);
      const space = readNonEmptyString(req.query?.space);
      const limit = parseOptionalPositiveInt(req.query?.limit, {
        fallback: DEFAULT_THREADS_LIMIT,
        max: MAX_THREADS_LIMIT,
      }) ?? DEFAULT_THREADS_LIMIT;
      const threads = listThreads(workspacePath, {
        status,
        space,
        limit,
      });
      res.json({
        ok: true,
        count: threads.length,
        threads,
      });
    } catch (error) {
      writeRouteError(res, error);
    }
  });

  app.get('/api/threads/:id', (req: any, res: any) => {
    try {
      const threadId = readNonEmptyString(req.params?.id);
      if (!threadId) {
        res.status(400).json({
          ok: false,
          error: 'Thread id is required.',
        });
        return;
      }
      const resolved = resolveThreadInstance(workspacePath, threadId);
      if (!resolved) {
        res.status(404).json({
          ok: false,
          error: `Thread not found: ${threadId}`,
        });
        return;
      }
      res.json({
        ok: true,
        thread: resolved,
        history: ledger.historyOf(workspacePath, resolved.path),
      });
    } catch (error) {
      writeRouteError(res, error);
    }
  });

  app.post('/api/threads', (req: any, res: any) => {
    try {
      const payload = toRecord(req.body);
      const actor = resolveMutationActor(req, workspacePath, payload.actor, defaultActor);
      const created = createThreadFromPayload(workspacePath, payload, actor);
      res.status(201).json({
        ok: true,
        thread: created,
      });
    } catch (error) {
      writeRouteError(res, error);
    }
  });

  app.patch('/api/threads/:id', (req: any, res: any) => {
    try {
      const threadId = readNonEmptyString(req.params?.id);
      if (!threadId) {
        res.status(400).json({
          ok: false,
          error: 'Thread id is required.',
        });
        return;
      }
      const payload = toRecord(req.body);
      const actor = resolveMutationActor(req, workspacePath, payload.actor, defaultActor);
      const updated = updateThreadFromPayload(workspacePath, threadId, payload, actor);
      res.json({
        ok: true,
        thread: updated,
      });
    } catch (error) {
      writeRouteError(res, error);
    }
  });

  app.get('/api/ledger', (req: any, res: any) => {
    try {
      const limit = parseOptionalPositiveInt(req.query?.limit, {
        fallback: DEFAULT_LEDGER_LIMIT,
        max: MAX_LEDGER_LIMIT,
      }) ?? DEFAULT_LEDGER_LIMIT;
      const entries = ledger.recent(workspacePath, limit);
      res.json({
        ok: true,
        count: entries.length,
        entries,
      });
    } catch (error) {
      writeRouteError(res, error);
    }
  });

  app.get('/api/lens/:name', (req: any, res: any) => {
    try {
      const lensName = readNonEmptyString(req.params?.name)?.toLowerCase();
      const space = readNonEmptyString(req.query?.space);
      if (!lensName) {
        res.status(400).json({
          ok: false,
          error: 'Lens name is required.',
        });
        return;
      }

      if (lensName === 'attention') {
        res.json({
          ok: true,
          ...buildAttentionLens(workspacePath, { space }),
        });
        return;
      }
      if (lensName === 'agents') {
        res.json({
          ok: true,
          ...buildAgentsLens(workspacePath, { space }),
        });
        return;
      }
      if (lensName === 'spaces') {
        res.json({
          ok: true,
          ...buildSpacesLens(workspacePath, { space }),
        });
        return;
      }
      if (lensName === 'timeline') {
        res.json({
          ok: true,
          ...buildTimelineLens(workspacePath, { space }),
        });
        return;
      }

      res.status(404).json({
        ok: false,
        error: `Unknown lens "${lensName}".`,
      });
    } catch (error) {
      writeRouteError(res, error);
    }
  });

  app.get('/api/webhooks', (_req: any, res: any) => {
    try {
      if (!featureFlags.webhooks) {
        res.status(404).json({
          ok: false,
          error: 'Webhooks are disabled for this deployment mode.',
        });
        return;
      }
      const webhooks = listWebhooks(workspacePath);
      res.json({
        ok: true,
        count: webhooks.length,
        webhooks,
      });
    } catch (error) {
      writeRouteError(res, error);
    }
  });

  app.post('/api/webhooks', (req: any, res: any) => {
    try {
      if (!featureFlags.webhooks) {
        res.status(404).json({
          ok: false,
          error: 'Webhooks are disabled for this deployment mode.',
        });
        return;
      }
      const payload = toRecord(req.body) as WebhookCreateRequestBody;
      const actor = resolveMutationActor(req, workspacePath, payload.actor, defaultActor);
      const url = readNonEmptyString(payload.url);
      if (!url) {
        throw new Error('Missing required field "url".');
      }
      const events = parseStringList(payload.events);
      if (!events || events.length === 0) {
        throw new Error('Missing required field "events".');
      }
      auth.assertAuthorizedMutation(workspacePath, {
        actor,
        action: 'webhook.register',
        target: '.workgraph/webhooks.json',
        requiredCapabilities: ['policy:manage', 'dispatch:run'],
        metadata: {
          module: 'control-api',
        },
      });
      const webhook = registerWebhook(workspacePath, {
        url,
        events,
        secret: readNonEmptyString(payload.secret),
      });
      ledger.append(workspacePath, actor, 'create', `.workgraph/webhooks/${webhook.id}`, 'webhook', {
        url: webhook.url,
        events: webhook.events,
      });
      res.status(201).json({
        ok: true,
        webhook,
      });
    } catch (error) {
      writeRouteError(res, error);
    }
  });

  app.delete('/api/webhooks/:id', (req: any, res: any) => {
    try {
      if (!featureFlags.webhooks) {
        res.status(404).json({
          ok: false,
          error: 'Webhooks are disabled for this deployment mode.',
        });
        return;
      }
      const actor = resolveMutationActor(req, workspacePath, undefined, defaultActor);
      const webhookId = readNonEmptyString(req.params?.id);
      if (!webhookId) {
        res.status(400).json({
          ok: false,
          error: 'Webhook id is required.',
        });
        return;
      }
      auth.assertAuthorizedMutation(workspacePath, {
        actor,
        action: 'webhook.delete',
        target: `.workgraph/webhooks.json#${webhookId}`,
        requiredCapabilities: ['policy:manage', 'dispatch:run'],
        metadata: {
          module: 'control-api',
        },
      });
      const deleted = deleteWebhook(workspacePath, webhookId);
      if (!deleted) {
        res.status(404).json({
          ok: false,
          error: `Webhook not found: ${webhookId}`,
        });
        return;
      }
      ledger.append(workspacePath, actor, 'delete', `.workgraph/webhooks/${webhookId}`, 'webhook');
      res.json({
        ok: true,
        id: webhookId,
      });
    } catch (error) {
      writeRouteError(res, error);
    }
  });
}

function ensureWorkspaceInitialized(workspacePath: string): boolean {
  let initialized = false;
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }
  if (!workspace.isWorkgraphWorkspace(workspacePath)) {
    workspace.initWorkspace(workspacePath);
    initialized = true;
  }
  return initialized;
}

function listThreads(
  workspacePath: string,
  options: { status?: string; space?: string; limit: number },
): Array<PrimitiveInstance & { ready: boolean }> {
  const baseThreads = options.space
    ? store.threadsInSpace(workspacePath, options.space)
    : store.list(workspacePath, 'thread');
  const readySet = new Set(
    (options.space
      ? thread.listReadyThreadsInSpace(workspacePath, options.space)
      : thread.listReadyThreads(workspacePath))
      .map((item) => item.path),
  );

  let filtered = baseThreads;
  if (options.status) {
    filtered = filtered.filter((item) => String(item.fields.status) === options.status);
  }

  return filtered
    .slice(0, options.limit)
    .map((item) => ({
      ...item,
      ready: readySet.has(item.path),
    }));
}

function createThreadFromPayload(
  workspacePath: string,
  payload: Record<string, unknown>,
  actor: string,
): PrimitiveInstance {
  const body = payload as ThreadCreateRequestBody;
  const goal = readNonEmptyString(body.goal) ?? readNonEmptyString(body.observation);
  if (!goal) {
    throw new Error('Missing required field "goal" (or "observation").');
  }
  const title = readNonEmptyString(body.title) ?? summarizeGoal(goal);
  return thread.createThread(workspacePath, title, goal, actor, {
    priority: readNonEmptyString(body.priority),
    deps: parseStringList(body.deps),
    parent: readNonEmptyString(body.parent),
    space: readNonEmptyString(body.space),
    context_refs: parseStringList(body.context_refs),
    tags: parseStringList(body.tags),
  });
}

function updateThreadFromPayload(
  workspacePath: string,
  rawThreadId: string,
  payload: Record<string, unknown>,
  actor: string,
): PrimitiveInstance {
  const threadInstance = resolveThreadInstance(workspacePath, rawThreadId);
  if (!threadInstance) {
    throw new Error(`Thread not found: ${rawThreadId}`);
  }

  const body = payload as ThreadUpdateRequestBody;
  const status = readNonEmptyString(body.status);
  if (!isThreadStatus(status)) {
    throw new Error('Invalid or missing field "status". Expected open|active|blocked|done|cancelled.');
  }

  const reason = readNonEmptyString(body.reason);
  const output = readNonEmptyString(body.output);
  const blockedBy = readNonEmptyString(body.blockedBy) ?? 'external/manual';
  const leaseTtlMinutes = parseOptionalPositiveInt(body.leaseTtlMinutes, {
    max: 24 * 60,
  });

  switch (status) {
    case 'open': {
      const currentStatus = String(threadInstance.fields.status);
      if (currentStatus === 'done' || currentStatus === 'cancelled') {
        return thread.reopen(workspacePath, threadInstance.path, actor, reason);
      }
      return thread.release(workspacePath, threadInstance.path, actor, reason);
    }
    case 'active': {
      const currentStatus = String(threadInstance.fields.status);
      if (currentStatus === 'blocked') {
        return thread.unblock(workspacePath, threadInstance.path, actor);
      }
      return thread.claim(workspacePath, threadInstance.path, actor, {
        leaseTtlMinutes,
      });
    }
    case 'blocked':
      return thread.block(workspacePath, threadInstance.path, actor, blockedBy, reason);
    case 'done':
      return thread.done(workspacePath, threadInstance.path, actor, output);
    case 'cancelled':
      return thread.cancel(workspacePath, threadInstance.path, actor, reason);
  }
}

function resolveThreadInstance(workspacePath: string, rawThreadId: string): PrimitiveInstance | null {
  const resolvedId = safeDecodeURIComponent(rawThreadId);
  const candidates = threadPathCandidates(resolvedId);
  for (const candidate of candidates) {
    const item = store.read(workspacePath, candidate);
    if (item && item.type === 'thread') {
      return item;
    }
  }
  return null;
}

function threadPathCandidates(raw: string): string[] {
  const normalized = normalizeThreadPath(raw);
  const output = new Set<string>();
  if (normalized) output.add(normalized);
  if (normalized && !normalized.startsWith('threads/')) {
    output.add(normalizeThreadPath(`threads/${normalized}`));
  }
  return [...output].filter(Boolean);
}

function normalizeThreadPath(raw: string): string {
  const trimmed = raw.trim().replace(/^\.\//, '');
  if (!trimmed) return '';
  if (trimmed.endsWith('.md')) return trimmed;
  return `${trimmed}.md`;
}

function summarizeGoal(goal: string): string {
  const line = goal.split('\n').map((item) => item.trim()).find(Boolean) ?? 'Untitled Thread';
  return line.slice(0, 80);
}

function parseOptionalPositiveInt(
  value: unknown,
  options: { fallback?: number; max?: number } = {},
): number | undefined {
  const normalized = readFirstValue(value);
  if (normalized === undefined || normalized === null || normalized === '') {
    if (options.fallback !== undefined) return options.fallback;
    return undefined;
  }

  const parsed = Number.parseInt(String(normalized), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer value "${String(normalized)}".`);
  }
  if (options.max !== undefined) {
    return Math.min(parsed, options.max);
  }
  return parsed;
}

function parseOptionalPort(value: unknown): number | undefined {
  const raw = readFirstValue(value);
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid port "${String(raw)}". Expected 0..65535.`);
  }
  return parsed;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  const raw = readFirstValue(value);
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'boolean') return raw;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return undefined;
}

function normalizePort(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 65535) {
    throw new Error(`Invalid port "${String(value)}". Expected 0..65535.`);
  }
  return Math.trunc(value);
}

function normalizeSseKeepaliveMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SSE_KEEPALIVE_MS;
  if (!Number.isFinite(value) || value < 100 || value > 60_000) {
    throw new Error(`Invalid sse keepalive "${String(value)}". Expected 100..60000 ms.`);
  }
  return Math.trunc(value);
}

function parseStringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const items = value
      .map((item) => String(item).trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  const fromString = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return fromString.length > 0 ? fromString : undefined;
}

function readCsvQueryValues(
  query: Record<string, unknown> | undefined,
  keys: string[],
): string[] | undefined {
  if (!query) return undefined;
  const values = new Set<string>();
  for (const key of keys) {
    const raw = query[key];
    if (raw === undefined || raw === null) continue;
    const normalized = parseStringList(raw);
    if (!normalized) continue;
    for (const item of normalized) {
      values.add(item);
    }
  }
  return values.size > 0 ? [...values] : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  const picked = readFirstValue(value);
  if (typeof picked !== 'string') return undefined;
  const trimmed = picked.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readFirstValue(value: unknown): unknown {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isThreadStatus(value: string | undefined): value is ThreadStatus {
  return value === 'open' || value === 'active' || value === 'blocked' || value === 'done' || value === 'cancelled';
}

function writeRouteError(res: any, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const status = inferHttpStatus(message);
  res.status(status).json({
    ok: false,
    error: message,
  });
}

function inferHttpStatus(message: string): number {
  if (message.includes('not found')) return 404;
  if (message.includes('already claimed') || message.includes('owned by')) return 409;
  if (
    message.includes('Identity verification failed') ||
    message.includes('Policy gate blocked') ||
    message.includes('Credential scope blocked') ||
    message.includes('Mutation blocked')
  ) {
    return 403;
  }
  if (
    message.includes('Invalid') ||
    message.includes('Missing') ||
    message.includes('Cannot') ||
    message.includes('Expected')
  ) {
    return 400;
  }
  return 500;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeStreamWrite(res: any, chunk: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

function logJson(level: LogLevel, event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  }));
}

function buildRequestAuthContext(req: any): { credentialToken?: string; source: 'rest' } {
  const credentialToken = readBearerToken(req?.headers?.authorization);
  return {
    ...(credentialToken ? { credentialToken } : {}),
    source: 'rest',
  };
}

function resolveMutationActor(
  req: any,
  workspacePath: string,
  explicitActor: unknown,
  defaultActor: string,
): string {
  const fromBody = readNonEmptyString(explicitActor);
  if (fromBody) return fromBody;
  const fromHeader = readNonEmptyString(req?.headers?.['x-workgraph-actor']);
  if (fromHeader) return fromHeader;
  const bearerToken = readBearerToken(req?.headers?.authorization);
  if (bearerToken) {
    const verification = auth.verifyAgentCredential(workspacePath, bearerToken, {
      touchLastUsed: false,
    });
    if (verification.valid && verification.credential) {
      return verification.credential.actor;
    }
  }
  return defaultActor;
}

function readBearerToken(headerValue: unknown): string | undefined {
  const authorization = readNonEmptyString(headerValue);
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return undefined;
  }
  return readNonEmptyString(authorization.slice('Bearer '.length));
}
