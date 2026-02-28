import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as dispatch from './dispatch.js';
import * as graph from './graph.js';
import * as ledger from './ledger.js';
import { startWorkgraphEventStream, type WorkgraphEventStreamHandle } from './mcp-events.js';
import * as orientation from './orientation.js';
import * as policy from './policy.js';
import * as query from './query.js';
import * as registry from './registry.js';
import * as store from './store.js';
import * as thread from './thread.js';
import type { PrimitiveInstance } from './types.js';

export interface WorkgraphMcpServerOptions {
  workspacePath: string;
  defaultActor?: string;
  readOnly?: boolean;
  name?: string;
  version?: string;
  sse?: {
    enabled?: boolean;
    host?: string;
    port?: number;
    path?: string;
    pollIntervalMs?: number;
    heartbeatMs?: number;
  };
}

const DEFAULT_SERVER_NAME = 'workgraph-mcp-server';
const DEFAULT_SERVER_VERSION = '0.1.0';
const DEFAULT_CONTEXT_BUDGET = 8_000;
const PRIMITIVE_TYPES = [
  'thread',
  'fact',
  'decision',
  'lesson',
  'agent',
  'skill',
  'policy',
  'incident',
  'trigger',
  'checkpoint',
  'run',
  'person',
  'project',
  'client',
  'space',
] as const;
const MCP_SSE_HANDLES = new WeakMap<McpServer, WorkgraphEventStreamHandle>();

export function createWorkgraphMcpServer(options: WorkgraphMcpServerOptions): McpServer {
  const server = new McpServer({
    name: options.name ?? DEFAULT_SERVER_NAME,
    version: options.version ?? DEFAULT_SERVER_VERSION,
  });

  registerResources(server, options);
  registerTools(server, options);
  return server;
}

export async function startWorkgraphMcpServer(options: WorkgraphMcpServerOptions): Promise<McpServer> {
  const server = createWorkgraphMcpServer(options);
  const shouldStartSse = Boolean(options.sse) && options.sse?.enabled !== false;
  if (shouldStartSse) {
    const eventStream = await startWorkgraphEventStream({
      workspacePath: options.workspacePath,
      host: options.sse?.host,
      port: options.sse?.port,
      path: options.sse?.path,
      pollIntervalMs: options.sse?.pollIntervalMs,
      heartbeatMs: options.sse?.heartbeatMs,
    });
    MCP_SSE_HANDLES.set(server, eventStream);
    const originalClose = server.close.bind(server);
    let closed = false;
    (server as McpServer & { close: () => Promise<void> }).close = async () => {
      if (!closed) {
        closed = true;
        await eventStream.close();
      }
      await originalClose();
    };
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

export function getWorkgraphMcpSseUrl(server: McpServer): string | null {
  return MCP_SSE_HANDLES.get(server)?.url ?? null;
}

function registerResources(server: McpServer, options: WorkgraphMcpServerOptions): void {
  server.registerResource(
    'workspace-status',
    'workgraph://status',
    {
      title: 'Workgraph Status Snapshot',
      description: 'Current thread/claim/primitive counts for the workspace.',
      mimeType: 'application/json',
    },
    async () => {
      const snapshot = orientation.statusSnapshot(options.workspacePath);
      return {
        contents: [
          {
            uri: 'workgraph://status',
            mimeType: 'application/json',
            text: toPrettyJson(buildVaultStatus(options.workspacePath, snapshot)),
          },
        ],
      };
    },
  );

  server.registerResource(
    'actor-brief',
    new ResourceTemplate('workgraph://brief/{actor}', { list: undefined }),
    {
      title: 'Actor Brief',
      description: 'Actor-specific operational brief derived from workspace state.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const actor = String(variables.actor ?? options.defaultActor ?? 'anonymous');
      const brief = orientation.brief(options.workspacePath, actor);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: toPrettyJson(brief),
          },
        ],
      };
    },
  );
}

function registerTools(server: McpServer, options: WorkgraphMcpServerOptions): void {
  server.registerTool(
    'workgraph_status',
    {
      title: 'Workgraph Status',
      description: 'Return a compact status snapshot for the configured workspace.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const snapshot = orientation.statusSnapshot(options.workspacePath);
        const status = buildVaultStatus(options.workspacePath, snapshot);
        return okResult(status, renderStatusSummary(status));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_brief',
    {
      title: 'Workgraph Brief',
      description: 'Return actor-centric operational brief (claims, blockers, and next work).',
      inputSchema: {
        actor: z.string().optional(),
        recentCount: z.number().int().min(1).max(100).optional(),
        nextCount: z.number().int().min(1).max(100).optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(args.actor, options.defaultActor);
        const brief = orientation.brief(options.workspacePath, actor, {
          recentCount: args.recentCount,
          nextCount: args.nextCount,
        });
        return okResult(brief, `Brief for ${actor}: claims=${brief.myClaims.length}, blocked=${brief.blockedThreads.length}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_query',
    {
      title: 'Workgraph Query',
      description: 'Query primitives using multi-field filters.',
      inputSchema: {
        type: z.string().optional(),
        status: z.string().optional(),
        owner: z.string().optional(),
        tag: z.string().optional(),
        text: z.string().optional(),
        pathIncludes: z.string().optional(),
        updatedAfter: z.string().optional(),
        updatedBefore: z.string().optional(),
        createdAfter: z.string().optional(),
        createdBefore: z.string().optional(),
        limit: z.number().int().min(0).max(1000).optional(),
        offset: z.number().int().min(0).max(10000).optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const results = query.queryPrimitives(options.workspacePath, {
          type: args.type,
          status: args.status,
          owner: args.owner,
          tag: args.tag,
          text: args.text,
          pathIncludes: args.pathIncludes,
          updatedAfter: args.updatedAfter,
          updatedBefore: args.updatedBefore,
          createdAfter: args.createdAfter,
          createdBefore: args.createdBefore,
          limit: args.limit,
          offset: args.offset,
        });
        return okResult({ results, count: results.length }, `Query returned ${results.length} primitive(s).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_thread_list',
    {
      title: 'Thread List',
      description: 'List workspace threads, optionally filtered by status/space/readiness.',
      inputSchema: {
        status: z.string().optional(),
        readyOnly: z.boolean().optional(),
        space: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        let threads = args.space
          ? store.threadsInSpace(options.workspacePath, args.space)
          : store.list(options.workspacePath, 'thread');
        const readySet = new Set(
          (args.space
            ? thread.listReadyThreadsInSpace(options.workspacePath, args.space)
            : thread.listReadyThreads(options.workspacePath))
            .map((entry) => entry.path),
        );
        if (args.status) {
          threads = threads.filter((entry) => String(entry.fields.status) === args.status);
        }
        if (args.readyOnly) {
          threads = threads.filter((entry) => readySet.has(entry.path));
        }
        const enriched = threads.map((entry) => ({
          ...entry,
          ready: readySet.has(entry.path),
        }));
        return okResult({ threads: enriched, count: enriched.length }, `Thread list returned ${enriched.length} item(s).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_thread_show',
    {
      title: 'Thread Show',
      description: 'Read one thread and its ledger history.',
      inputSchema: {
        threadPath: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const threadEntry = store.read(options.workspacePath, args.threadPath);
        if (!threadEntry) {
          return errorResult(`Thread not found: ${args.threadPath}`);
        }
        const history = ledger.historyOf(options.workspacePath, args.threadPath);
        return okResult({ thread: threadEntry, history }, `Thread ${args.threadPath} has ${history.length} ledger event(s).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_ledger_recent',
    {
      title: 'Ledger Recent',
      description: 'Read recent ledger events.',
      inputSchema: {
        count: z.number().int().min(1).max(500).optional(),
        actor: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        let entries = ledger.recent(options.workspacePath, args.count ?? 20);
        if (args.actor) {
          entries = entries.filter((entry) => entry.actor === args.actor);
        }
        return okResult({ entries, count: entries.length }, `Ledger returned ${entries.length} event(s).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_graph_hygiene',
    {
      title: 'Graph Hygiene',
      description: 'Generate wiki-link graph hygiene report.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const report = graph.graphHygieneReport(options.workspacePath);
        return okResult(
          report,
          `Graph hygiene: nodes=${report.nodeCount}, edges=${report.edgeCount}, orphans=${report.orphanCount}, broken=${report.brokenLinkCount}`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_thread_claim',
    {
      title: 'Thread Claim',
      description: 'Claim a thread for an actor (policy-scoped write).',
      inputSchema: {
        threadPath: z.string().min(1),
        actor: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['thread:claim', 'mcp:write']);
        if (!gate.allowed) return errorResult(gate.reason);
        const updated = thread.claim(options.workspacePath, args.threadPath, actor);
        return okResult({ thread: updated }, `Claimed ${updated.path} as ${actor}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_thread_done',
    {
      title: 'Thread Done',
      description: 'Mark a thread as done with output summary (policy-scoped write).',
      inputSchema: {
        threadPath: z.string().min(1),
        actor: z.string().optional(),
        output: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['thread:done', 'mcp:write']);
        if (!gate.allowed) return errorResult(gate.reason);
        const updated = thread.done(options.workspacePath, args.threadPath, actor, args.output);
        return okResult({ thread: updated }, `Marked ${updated.path} done as ${actor}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_checkpoint_create',
    {
      title: 'Checkpoint Create',
      description: 'Create a checkpoint primitive for hand-off continuity (policy-scoped write).',
      inputSchema: {
        actor: z.string().optional(),
        summary: z.string().min(1),
        next: z.array(z.string()).optional(),
        blocked: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['checkpoint:create', 'mcp:write']);
        if (!gate.allowed) return errorResult(gate.reason);
        const checkpoint = orientation.checkpoint(options.workspacePath, actor, args.summary, {
          next: args.next,
          blocked: args.blocked,
          tags: args.tags,
        });
        return okResult({ checkpoint }, `Created checkpoint ${checkpoint.path}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_dispatch_create',
    {
      title: 'Dispatch Create',
      description: 'Create a dispatch run request (policy-scoped write).',
      inputSchema: {
        actor: z.string().optional(),
        objective: z.string().min(1),
        adapter: z.string().optional(),
        idempotencyKey: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['dispatch:run', 'mcp:write']);
        if (!gate.allowed) return errorResult(gate.reason);
        const run = dispatch.createRun(options.workspacePath, {
          actor,
          objective: args.objective,
          adapter: args.adapter,
          idempotencyKey: args.idempotencyKey,
        });
        return okResult({ run }, `Created run ${run.id} (${run.status}).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_dispatch_execute',
    {
      title: 'Dispatch Execute',
      description: 'Execute one queued/running run through its adapter (policy-scoped write).',
      inputSchema: {
        actor: z.string().optional(),
        runId: z.string().min(1),
        agents: z.array(z.string()).optional(),
        maxSteps: z.number().int().min(1).max(5000).optional(),
        stepDelayMs: z.number().int().min(0).max(5000).optional(),
        space: z.string().optional(),
        createCheckpoint: z.boolean().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['dispatch:run', 'mcp:write']);
        if (!gate.allowed) return errorResult(gate.reason);
        const run = await dispatch.executeRun(options.workspacePath, args.runId, {
          actor,
          agents: args.agents,
          maxSteps: args.maxSteps,
          stepDelayMs: args.stepDelayMs,
          space: args.space,
          createCheckpoint: args.createCheckpoint,
        });
        return okResult({ run }, `Executed run ${run.id} -> ${run.status}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_dispatch_followup',
    {
      title: 'Dispatch Follow-up',
      description: 'Send follow-up input to a run (policy-scoped write).',
      inputSchema: {
        actor: z.string().optional(),
        runId: z.string().min(1),
        input: z.string().min(1),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['dispatch:run', 'mcp:write']);
        if (!gate.allowed) return errorResult(gate.reason);
        const run = dispatch.followup(options.workspacePath, args.runId, actor, args.input);
        return okResult({ run }, `Follow-up recorded for ${run.id}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_dispatch_stop',
    {
      title: 'Dispatch Stop',
      description: 'Stop/cancel a run (policy-scoped write).',
      inputSchema: {
        actor: z.string().optional(),
        runId: z.string().min(1),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['dispatch:run', 'mcp:write']);
        if (!gate.allowed) return errorResult(gate.reason);
        const run = dispatch.stop(options.workspacePath, args.runId, actor);
        return okResult({ run }, `Stopped run ${run.id}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerPrimitiveCrudTools(server, options);
  registerContextAndGraphTools(server, options);
  registerDispatchAliasTools(server, options);
}

function registerPrimitiveCrudTools(server: McpServer, options: WorkgraphMcpServerOptions): void {
  for (const primitiveType of PRIMITIVE_TYPES) {
    if (primitiveType !== 'checkpoint') {
      server.registerTool(
        `workgraph_${primitiveType}_create`,
        {
          title: `${capitalize(primitiveType)} Create`,
          description: `Create a ${primitiveType} primitive.`,
          inputSchema: {
            actor: z.string().optional(),
            title: z.string().optional(),
            fields: z.record(z.string(), z.unknown()).optional(),
            body: z.string().optional(),
            path: z.string().optional(),
          },
          annotations: {
            destructiveHint: true,
            idempotentHint: false,
          },
        },
        async (args) => {
          try {
            assertPrimitiveTypeRegistered(options.workspacePath, primitiveType);
            const actor = resolveActor(args.actor, options.defaultActor);
            const gate = checkWriteGate(options, actor, ['mcp:write']);
            if (!gate.allowed) return errorResult(gate.reason);
            const fields = normalizeFieldInput(args.fields);
            if (args.title && fields.title === undefined) {
              fields.title = args.title;
            }
            const primitive = store.create(
              options.workspacePath,
              primitiveType,
              fields,
              args.body ?? '',
              actor,
              args.path ? { pathOverride: args.path } : {},
            );
            return okResult(
              { primitive },
              `Created ${primitiveType} primitive at ${primitive.path}.`,
            );
          } catch (error) {
            return errorResult(error);
          }
        },
      );
    }

    server.registerTool(
      `workgraph_${primitiveType}_read`,
      {
        title: `${capitalize(primitiveType)} Read`,
        description: `Read one ${primitiveType} primitive by path or slug.`,
        inputSchema: {
          ref: z.string().min(1),
          includeHistory: z.boolean().optional(),
        },
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
        },
      },
      async (args) => {
        try {
          assertPrimitiveTypeRegistered(options.workspacePath, primitiveType);
          const resolvedPath = resolvePrimitivePath(options.workspacePath, primitiveType, args.ref);
          if (!resolvedPath) {
            return errorResult(`${capitalize(primitiveType)} not found for ref "${args.ref}".`);
          }
          const primitive = store.read(options.workspacePath, resolvedPath);
          if (!primitive) {
            return errorResult(`${capitalize(primitiveType)} not found: ${resolvedPath}`);
          }
          const includeHistory = args.includeHistory ?? primitiveType === 'thread';
          const history = includeHistory
            ? ledger.historyOf(options.workspacePath, primitive.path)
            : undefined;
          return okResult(
            history ? { primitive, history } : { primitive },
            `Read ${primitiveType} primitive ${primitive.path}.`,
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    server.registerTool(
      `workgraph_${primitiveType}_update`,
      {
        title: `${capitalize(primitiveType)} Update`,
        description: `Update a ${primitiveType} primitive by path or slug.`,
        inputSchema: {
          actor: z.string().optional(),
          ref: z.string().min(1),
          fields: z.record(z.string(), z.unknown()).optional(),
          body: z.string().optional(),
        },
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      async (args) => {
        try {
          assertPrimitiveTypeRegistered(options.workspacePath, primitiveType);
          const actor = resolveActor(args.actor, options.defaultActor);
          const gate = checkWriteGate(options, actor, ['mcp:write']);
          if (!gate.allowed) return errorResult(gate.reason);
          const resolvedPath = resolvePrimitivePath(options.workspacePath, primitiveType, args.ref);
          if (!resolvedPath) {
            return errorResult(`${capitalize(primitiveType)} not found for ref "${args.ref}".`);
          }
          const primitive = store.update(
            options.workspacePath,
            resolvedPath,
            normalizeFieldInput(args.fields),
            args.body,
            actor,
          );
          return okResult(
            { primitive },
            `Updated ${primitiveType} primitive ${primitive.path}.`,
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    if (primitiveType !== 'thread') {
      server.registerTool(
        `workgraph_${primitiveType}_list`,
        {
          title: `${capitalize(primitiveType)} List`,
          description: `List ${primitiveType} primitives with optional filters.`,
          inputSchema: {
            status: z.string().optional(),
            owner: z.string().optional(),
            tag: z.string().optional(),
            text: z.string().optional(),
            limit: z.number().int().min(0).max(1000).optional(),
            offset: z.number().int().min(0).max(10000).optional(),
          },
          annotations: {
            readOnlyHint: true,
            idempotentHint: true,
          },
        },
        async (args) => {
          try {
            assertPrimitiveTypeRegistered(options.workspacePath, primitiveType);
            const primitives = query.queryPrimitives(options.workspacePath, {
              type: primitiveType,
              status: args.status,
              owner: args.owner,
              tag: args.tag,
              text: args.text,
              limit: args.limit,
              offset: args.offset,
            });
            return okResult(
              { primitives, count: primitives.length },
              `${capitalize(primitiveType)} list returned ${primitives.length} item(s).`,
            );
          } catch (error) {
            return errorResult(error);
          }
        },
      );
    }

    server.registerTool(
      `workgraph_${primitiveType}_search`,
      {
        title: `${capitalize(primitiveType)} Search`,
        description: `Keyword search within ${primitiveType} primitives.`,
        inputSchema: {
          text: z.string().min(1),
          status: z.string().optional(),
          owner: z.string().optional(),
          tag: z.string().optional(),
          limit: z.number().int().min(0).max(1000).optional(),
          offset: z.number().int().min(0).max(10000).optional(),
        },
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
        },
      },
      async (args) => {
        try {
          assertPrimitiveTypeRegistered(options.workspacePath, primitiveType);
          const results = query.keywordSearch(options.workspacePath, args.text, {
            type: primitiveType,
            status: args.status,
            owner: args.owner,
            tag: args.tag,
            limit: args.limit,
            offset: args.offset,
          });
          return okResult(
            { results, count: results.length },
            `${capitalize(primitiveType)} search returned ${results.length} result(s).`,
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  }
}

function registerContextAndGraphTools(server: McpServer, options: WorkgraphMcpServerOptions): void {
  server.registerTool(
    'workgraph_context',
    {
      title: 'Workgraph Context',
      description: 'Assemble best-effort task context from thread and related primitives.',
      inputSchema: {
        task: z.string().optional(),
        threadSlug: z.string().optional(),
        budget: z.number().int().min(1000).max(50000).optional(),
        hops: z.number().int().min(1).max(5).optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const budget = args.budget ?? DEFAULT_CONTEXT_BUDGET;
        const anchorThread = resolveContextThread(
          options.workspacePath,
          args.threadSlug,
          args.task,
        );
        if (!anchorThread) {
          return errorResult(
            `Unable to resolve context thread. Provide a valid threadSlug or a task matching an existing thread.`,
          );
        }
        const assembled = assembleContextMarkdown(options.workspacePath, anchorThread, {
          task: args.task,
          budget,
          hops: args.hops ?? 2,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: assembled.markdown,
            },
          ],
          structuredContent: {
            thread: anchorThread.path,
            budget,
            truncated: assembled.truncated,
            includedPaths: assembled.includedPaths,
            relatedCount: assembled.includedPaths.length - 1,
            markdown: assembled.markdown,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_search',
    {
      title: 'Workgraph Search',
      description: 'Keyword search across all primitives.',
      inputSchema: {
        text: z.string().min(1),
        type: z.string().optional(),
        status: z.string().optional(),
        owner: z.string().optional(),
        tag: z.string().optional(),
        limit: z.number().int().min(0).max(1000).optional(),
        offset: z.number().int().min(0).max(10000).optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const results = query.keywordSearch(options.workspacePath, args.text, {
          type: args.type,
          status: args.status,
          owner: args.owner,
          tag: args.tag,
          limit: args.limit,
          offset: args.offset,
        });
        return okResult(
          { results, count: results.length },
          `Workgraph search returned ${results.length} result(s).`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_neighborhood',
    {
      title: 'Workgraph Neighborhood',
      description: 'Return related primitives within N wiki-link hops.',
      inputSchema: {
        primitiveRef: z.string().min(1),
        hops: z.number().int().min(1).max(5).optional(),
        refresh: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const resolved = resolveAnyPrimitive(options.workspacePath, args.primitiveRef);
        const center = resolved?.path ?? normalizePathLikeRef(args.primitiveRef);
        const index = args.refresh
          ? graph.refreshWikiLinkGraphIndex(options.workspacePath)
          : (graph.readWikiLinkGraphIndex(options.workspacePath) ?? graph.buildWikiLinkGraph(options.workspacePath));
        const neighborhood = computeNeighborhood(index, center, args.hops ?? 1);
        const nodes = neighborhood.nodes.map(({ path, distance }) => {
          const primitive = store.read(options.workspacePath, path);
          return {
            path,
            distance,
            type: primitive?.type ?? null,
            title: primitive ? String(primitive.fields.title ?? primitive.fields.name ?? '') : '',
            exists: primitive !== null,
          };
        });
        return okResult(
          {
            center,
            hops: neighborhood.hops,
            nodes,
            edges: neighborhood.edges,
            count: nodes.length,
          },
          `Neighborhood for ${center} returned ${nodes.length} node(s) across ${neighborhood.hops} hop(s).`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_impact',
    {
      title: 'Workgraph Impact',
      description: 'Return primitives that reference the target primitive.',
      inputSchema: {
        primitiveRef: z.string().min(1),
        limit: z.number().int().min(1).max(1000).optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const target = resolveAnyPrimitive(options.workspacePath, args.primitiveRef);
        if (!target) return errorResult(`Primitive not found for ref "${args.primitiveRef}".`);
        const maxItems = args.limit ?? 200;
        const impact = collectImpactReferences(options.workspacePath, target.path, maxItems);
        return okResult(
          {
            target: target.path,
            references: impact,
            count: impact.length,
          },
          `Impact analysis found ${impact.length} reference(s) to ${target.path}.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

function registerDispatchAliasTools(server: McpServer, options: WorkgraphMcpServerOptions): void {
  server.registerTool(
    'workgraph_claim',
    {
      title: 'Workgraph Claim',
      description: 'Claim a thread for an actor.',
      inputSchema: {
        threadPath: z.string().min(1),
        actor: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['thread:claim', 'mcp:write']);
        if (!gate.allowed) return errorResult(gate.reason);
        const threadPath = resolvePrimitivePath(options.workspacePath, 'thread', args.threadPath) ?? args.threadPath;
        const claimed = thread.claim(options.workspacePath, threadPath, actor);
        return okResult({ thread: claimed }, `Claimed ${claimed.path} as ${actor}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_complete',
    {
      title: 'Workgraph Complete',
      description: 'Mark a run as succeeded/done.',
      inputSchema: {
        runId: z.string().min(1),
        actor: z.string().optional(),
        output: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['dispatch:run', 'mcp:write']);
        if (!gate.allowed) return errorResult(gate.reason);
        const run = completeRun(options.workspacePath, args.runId, actor, args.output);
        return okResult({ run }, `Marked run ${run.id} as ${run.status}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_heartbeat',
    {
      title: 'Workgraph Heartbeat',
      description: 'Extend the lease metadata for an actively claimed thread.',
      inputSchema: {
        threadPath: z.string().min(1),
        actor: z.string().optional(),
        leaseMinutes: z.number().int().min(1).max(720).optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['thread:claim', 'mcp:write']);
        if (!gate.allowed) return errorResult(gate.reason);
        const threadPath = resolvePrimitivePath(options.workspacePath, 'thread', args.threadPath) ?? args.threadPath;
        const updated = thread.heartbeat(options.workspacePath, threadPath, actor, args.leaseMinutes);
        return okResult({ thread: updated }, `Heartbeat extended for ${updated.path}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_handoff',
    {
      title: 'Workgraph Handoff',
      description: 'Transfer an active thread claim to another actor.',
      inputSchema: {
        threadPath: z.string().min(1),
        fromActor: z.string().optional(),
        toActor: z.string().min(1),
        note: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const fromActor = resolveActor(args.fromActor, options.defaultActor);
        const gate = checkWriteGate(options, fromActor, ['thread:claim', 'mcp:write']);
        if (!gate.allowed) return errorResult(gate.reason);
        const threadPath = resolvePrimitivePath(options.workspacePath, 'thread', args.threadPath) ?? args.threadPath;
        const updated = thread.handoff(
          options.workspacePath,
          threadPath,
          fromActor,
          args.toActor,
          args.note,
        );
        return okResult(
          { thread: updated },
          `Handed off ${updated.path} from ${fromActor} to ${String(updated.fields.owner ?? args.toActor)}.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

function completeRun(
  workspacePath: string,
  runId: string,
  actor: string,
  output?: string,
) {
  const current = dispatch.status(workspacePath, runId);
  if (current.status === 'failed' || current.status === 'cancelled') {
    throw new Error(`Cannot complete run ${runId} from terminal status "${current.status}".`);
  }
  if (current.status === 'queued') {
    dispatch.markRun(workspacePath, runId, actor, 'running');
  }
  return dispatch.markRun(workspacePath, runId, actor, 'succeeded', {
    output,
  });
}

function buildVaultStatus(
  workspacePath: string,
  snapshot: ReturnType<typeof orientation.statusSnapshot>,
) {
  const activeClaims = [...ledger.allClaims(workspacePath).entries()].map(([target, owner]) => ({
    target,
    owner,
  }));
  const activeThreads = store.list(workspacePath, 'thread')
    .filter((item) => String(item.fields.status) === 'active')
    .map((item) => ({
      path: item.path,
      title: String(item.fields.title ?? ''),
      owner: item.fields.owner ? String(item.fields.owner) : null,
      priority: item.fields.priority ? String(item.fields.priority) : null,
    }));
  const triggers = store.list(workspacePath, 'trigger');
  const triggerByStatus = triggers.reduce<Record<string, number>>((acc, item) => {
    const status = String(item.fields.status ?? 'unknown');
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});

  return {
    generatedAt: snapshot.generatedAt,
    workspacePath,
    primitives: snapshot.primitives,
    threads: {
      ...snapshot.threads,
      activeItems: activeThreads,
    },
    claims: {
      active: snapshot.claims.active,
      entries: activeClaims,
    },
    triggers: {
      total: triggers.length,
      byStatus: triggerByStatus,
      active: triggerByStatus.active ?? 0,
      approved: triggerByStatus.approved ?? 0,
    },
  };
}

function assertPrimitiveTypeRegistered(workspacePath: string, primitiveType: string): void {
  if (!registry.getType(workspacePath, primitiveType)) {
    throw new Error(
      `Primitive type "${primitiveType}" is not registered in this workspace. Define it first via workgraph primitive define.`,
    );
  }
}

function normalizeFieldInput(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    output[key] = value;
  }
  return output;
}

function resolvePrimitivePath(
  workspacePath: string,
  primitiveType: string,
  ref: string,
): string | null {
  const normalizedRef = String(ref).trim();
  if (!normalizedRef) return null;

  const typeDef = registry.getType(workspacePath, primitiveType);
  const directory = typeDef?.directory ?? `${primitiveType}s`;
  const candidatePaths = new Set<string>();
  if (normalizedRef.includes('/')) {
    candidatePaths.add(normalizePathLikeRef(normalizedRef));
  } else {
    candidatePaths.add(normalizePathLikeRef(`${directory}/${normalizedRef}`));
    candidatePaths.add(normalizePathLikeRef(`${directory}/${slugifyLookup(normalizedRef)}`));
    candidatePaths.add(normalizePathLikeRef(normalizedRef));
  }

  for (const candidate of candidatePaths) {
    const primitive = store.read(workspacePath, candidate);
    if (primitive && primitive.type === primitiveType) return primitive.path;
  }

  const available = store.list(workspacePath, primitiveType);
  const slugCandidate = slugifyLookup(normalizedRef);
  const normalizedPathCandidate = normalizePathLikeRef(normalizedRef).toLowerCase();
  const normalizedSlugPathCandidate = normalizePathLikeRef(`${directory}/${slugCandidate}`).toLowerCase();
  const normalizedBareCandidate = normalizedRef.toLowerCase().replace(/\.md$/, '');

  const byPath = available.find((entry) => {
    const lowered = entry.path.toLowerCase();
    if (lowered === normalizedPathCandidate) return true;
    if (lowered === normalizedSlugPathCandidate) return true;
    return lowered.endsWith(`/${normalizedBareCandidate}.md`);
  });
  if (byPath) return byPath.path;

  const byTitle = available.find((entry) => {
    const title = String(entry.fields.title ?? entry.fields.name ?? '').trim().toLowerCase();
    return title.length > 0 && title === normalizedRef.toLowerCase();
  });
  return byTitle?.path ?? null;
}

function resolveAnyPrimitive(workspacePath: string, ref: string): PrimitiveInstance | null {
  const normalizedRef = normalizePathLikeRef(ref);
  const direct = store.read(workspacePath, normalizedRef);
  if (direct) return direct;

  const all = query.queryPrimitives(workspacePath);
  const bare = String(ref).trim().toLowerCase().replace(/\.md$/, '');
  const slug = slugifyLookup(String(ref));
  const directMatch = all.find((entry) => {
    const pathLower = entry.path.toLowerCase();
    if (pathLower === normalizedRef.toLowerCase()) return true;
    if (pathLower.endsWith(`/${bare}.md`)) return true;
    if (pathLower.endsWith(`/${slug}.md`)) return true;
    const title = String(entry.fields.title ?? entry.fields.name ?? '').trim().toLowerCase();
    return title.length > 0 && title === bare;
  });
  return directMatch ?? null;
}

function resolveContextThread(
  workspacePath: string,
  threadSlug: string | undefined,
  task: string | undefined,
): PrimitiveInstance | null {
  if (threadSlug) {
    const resolved = resolvePrimitivePath(workspacePath, 'thread', threadSlug);
    if (!resolved) return null;
    return store.read(workspacePath, resolved);
  }
  if (!task) return null;

  const candidates = query.keywordSearch(workspacePath, task, {
    type: 'thread',
    limit: 25,
  });
  if (candidates.length === 0) return null;

  const ranked = candidates
    .map((entry) => ({
      entry,
      score: scoreThreadAgainstTask(task, entry),
    }))
    .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));
  return ranked[0]?.entry ?? null;
}

function scoreThreadAgainstTask(task: string, threadInstance: PrimitiveInstance): number {
  const taskTokens = task.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  const haystack = [
    String(threadInstance.fields.title ?? ''),
    String(threadInstance.fields.goal ?? ''),
    threadInstance.body,
    threadInstance.path,
  ].join('\n').toLowerCase();
  let score = 0;
  for (const token of taskTokens) {
    if (haystack.includes(token)) score += 1;
  }
  if (taskTokens.length === 0 && haystack.includes(task.toLowerCase())) {
    score += 1;
  }
  return score;
}

function assembleContextMarkdown(
  workspacePath: string,
  anchorThread: PrimitiveInstance,
  options: { task?: string; budget: number; hops: number },
): { markdown: string; truncated: boolean; includedPaths: string[] } {
  const index = graph.readWikiLinkGraphIndex(workspacePath) ?? graph.buildWikiLinkGraph(workspacePath);
  const neighborhood = computeNeighborhood(index, anchorThread.path, options.hops);
  const discoveredPaths = new Set<string>([anchorThread.path]);
  for (const node of neighborhood.nodes) {
    discoveredPaths.add(node.path);
  }
  for (const ref of extractLinkedRefs(anchorThread)) {
    discoveredPaths.add(ref);
  }
  for (const knowledge of collectKnowledgePrimitives(workspacePath, anchorThread, options.task)) {
    discoveredPaths.add(knowledge.path);
  }

  const instances: PrimitiveInstance[] = [];
  for (const pathValue of discoveredPaths) {
    const item = store.read(workspacePath, pathValue);
    if (item) instances.push(item);
  }

  const sorted = instances
    .sort((a, b) => {
      if (a.path === anchorThread.path) return -1;
      if (b.path === anchorThread.path) return 1;
      return a.path.localeCompare(b.path);
    });

  const headingLines = [
    '# WorkGraph Context',
    '',
    `- Anchor thread: \`${anchorThread.path}\``,
    `- Hops: ${options.hops}`,
    `- Budget: ${options.budget} chars`,
    ...(options.task ? [`- Task: ${options.task}`] : []),
    '',
  ];
  let markdown = headingLines.join('\n');
  let truncated = false;
  const includedPaths: string[] = [];

  for (const primitive of sorted) {
    const section = renderContextSection(primitive, primitive.path === anchorThread.path);
    if (markdown.length + section.length > options.budget) {
      truncated = true;
      break;
    }
    markdown += section;
    includedPaths.push(primitive.path);
  }

  if (truncated) {
    const footer = '\n> Context was truncated to satisfy the configured budget.\n';
    if (markdown.length + footer.length <= options.budget) {
      markdown += footer;
    }
  }

  return {
    markdown,
    truncated,
    includedPaths,
  };
}

function renderContextSection(primitive: PrimitiveInstance, isAnchor: boolean): string {
  const title = String(primitive.fields.title ?? primitive.fields.name ?? primitive.path);
  const keyFields = summarizeKeyFields(primitive.fields);
  const body = primitive.body.trim();
  const bodyExcerpt = body.length > 1000 ? `${body.slice(0, 1000)}...` : body;
  return [
    `## ${isAnchor ? 'Anchor' : 'Related'}: ${title}`,
    '',
    `- Type: ${primitive.type}`,
    `- Path: \`${primitive.path}\``,
    ...(keyFields.length > 0 ? keyFields.map((line) => `- ${line}`) : []),
    '',
    bodyExcerpt.length > 0 ? bodyExcerpt : '_No body content._',
    '',
  ].join('\n');
}

function summarizeKeyFields(fields: Record<string, unknown>): string[] {
  const keys = [
    'status',
    'owner',
    'priority',
    'goal',
    'summary',
    'date',
    'severity',
    'actor',
    'space',
    'client',
    'updated',
    'created',
  ];
  const output: string[] = [];
  for (const key of keys) {
    if (fields[key] === undefined || fields[key] === null) continue;
    output.push(`${key}: ${renderFieldValue(fields[key])}`);
  }
  return output;
}

function renderFieldValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(', ');
  }
  if (typeof value === 'object') {
    return toPrettyJson(value);
  }
  return String(value);
}

function extractLinkedRefs(instance: PrimitiveInstance): string[] {
  const refs = new Set<string>();
  for (const link of extractWikiLinks(instance.body)) {
    refs.add(link);
  }
  for (const value of Object.values(instance.fields)) {
    if (typeof value === 'string' && looksLikeWorkspaceRef(value)) {
      refs.add(normalizePathLikeRef(value));
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && looksLikeWorkspaceRef(item)) {
          refs.add(normalizePathLikeRef(item));
        }
      }
    }
  }
  refs.delete(instance.path);
  return [...refs];
}

function collectKnowledgePrimitives(
  workspacePath: string,
  anchorThread: PrimitiveInstance,
  task: string | undefined,
): PrimitiveInstance[] {
  const collected = new Map<string, PrimitiveInstance>();
  const tokens = new Set<string>();
  tokens.add(anchorThread.path);
  const anchorTitle = String(anchorThread.fields.title ?? '').trim();
  if (anchorTitle) tokens.add(anchorTitle);
  if (task && task.trim()) tokens.add(task.trim());

  for (const token of tokens) {
    for (const typeName of ['fact', 'decision', 'lesson']) {
      const matches = query.keywordSearch(workspacePath, token, {
        type: typeName,
        limit: 10,
      });
      for (const item of matches) {
        collected.set(item.path, item);
      }
    }
  }
  return [...collected.values()];
}

function computeNeighborhood(
  index: ReturnType<typeof graph.buildWikiLinkGraph>,
  center: string,
  hops: number,
): { hops: number; nodes: Array<{ path: string; distance: number }>; edges: Array<{ from: string; to: string }> } {
  const safeHops = Math.max(1, hops);
  const adjacency = new Map<string, Set<string>>();
  for (const edge of index.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
    adjacency.get(edge.from)!.add(edge.to);
    adjacency.get(edge.to)!.add(edge.from);
  }

  const queue: Array<{ path: string; distance: number }> = [{ path: center, distance: 0 }];
  const visited = new Map<string, number>([[center, 0]]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.distance >= safeHops) continue;
    const neighbors = adjacency.get(current.path);
    if (!neighbors) continue;
    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) continue;
      const distance = current.distance + 1;
      visited.set(neighbor, distance);
      queue.push({ path: neighbor, distance });
    }
  }

  const selected = new Set(visited.keys());
  const nodes = [...visited.entries()]
    .map(([path, distance]) => ({ path, distance }))
    .sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path));
  const edges = index.edges
    .filter((edge) => selected.has(edge.from) && selected.has(edge.to))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return {
    hops: safeHops,
    nodes,
    edges,
  };
}

function collectImpactReferences(
  workspacePath: string,
  targetPath: string,
  limit: number,
): Array<{ source: string; type: string; via: string }> {
  const references: Array<{ source: string; type: string; via: string }> = [];
  const seen = new Set<string>();

  const neighborhood = graph.graphNeighborhood(workspacePath, targetPath);
  for (const source of neighborhood.incoming) {
    const primitive = store.read(workspacePath, source);
    const key = `${source}::wiki-link`;
    if (!primitive || seen.has(key)) continue;
    seen.add(key);
    references.push({
      source,
      type: primitive.type,
      via: 'wiki-link',
    });
    if (references.length >= limit) return references;
  }

  const normalizedTarget = normalizePathLikeRef(targetPath);
  for (const primitive of query.queryPrimitives(workspacePath)) {
    if (primitive.path === normalizedTarget) continue;
    for (const [fieldName, fieldValue] of Object.entries(primitive.fields)) {
      if (fieldContainsRef(fieldValue, normalizedTarget)) {
        const key = `${primitive.path}::field:${fieldName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        references.push({
          source: primitive.path,
          type: primitive.type,
          via: `field:${fieldName}`,
        });
        if (references.length >= limit) return references;
      }
    }
  }

  return references;
}

function fieldContainsRef(value: unknown, normalizedTarget: string): boolean {
  if (typeof value === 'string') {
    return normalizePathLikeRef(value) === normalizedTarget;
  }
  if (Array.isArray(value)) {
    return value.some((item) =>
      typeof item === 'string' && normalizePathLikeRef(item) === normalizedTarget
    );
  }
  return false;
}

function extractWikiLinks(content: string): string[] {
  const refs: string[] = [];
  const matches = content.matchAll(/\[\[([^[\]]+)\]\]/g);
  for (const match of matches) {
    const raw = match[1]?.split('|')[0]?.trim();
    if (!raw) continue;
    refs.push(normalizePathLikeRef(raw));
  }
  return refs;
}

function looksLikeWorkspaceRef(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return false;
  if (trimmed.startsWith('external/')) return false;
  return trimmed.includes('/') || trimmed.endsWith('.md') || trimmed.startsWith('[[');
}

function normalizePathLikeRef(ref: string): string {
  const raw = String(ref).trim().replace(/\\/g, '/');
  if (!raw) return raw;
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2).split('|')[0].trim()
    : raw.split('|')[0].trim();
  if (!unwrapped) return unwrapped;
  if (unwrapped.startsWith('http://') || unwrapped.startsWith('https://')) return unwrapped;
  return unwrapped.endsWith('.md') ? unwrapped : `${unwrapped}.md`;
}

function slugifyLookup(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function capitalize(value: string): string {
  if (!value) return value;
  return value[0].toUpperCase() + value.slice(1);
}

function resolveActor(actor: string | undefined, defaultActor: string | undefined): string {
  const resolved = actor ?? defaultActor ?? 'anonymous';
  return String(resolved);
}

function checkWriteGate(
  options: WorkgraphMcpServerOptions,
  actor: string,
  requiredCapabilities: string[],
): { allowed: true } | { allowed: false; reason: string } {
  if (options.readOnly) {
    return {
      allowed: false,
      reason: 'MCP server is configured read-only; write tool is disabled.',
    };
  }

  if (actor === 'system') {
    return { allowed: true };
  }

  const party = policy.getParty(options.workspacePath, actor);
  if (!party) {
    return {
      allowed: false,
      reason: `Policy gate blocked MCP write: actor "${actor}" is not a registered party.`,
    };
  }

  const hasCapability = requiredCapabilities.some((capability) => party.capabilities.includes(capability));
  if (!hasCapability) {
    return {
      allowed: false,
      reason: `Policy gate blocked MCP write: actor "${actor}" lacks capabilities [${requiredCapabilities.join(', ')}].`,
    };
  }

  return { allowed: true };
}

function okResult(data: unknown, summary: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `${summary}\n\n${toPrettyJson(data)}`,
      },
    ],
    structuredContent: data as Record<string, unknown>,
  };
}

function errorResult(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
  };
}

function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function renderStatusSummary(snapshot: ReturnType<typeof buildVaultStatus>): string {
  return [
    `threads(total=${snapshot.threads.total}, open=${snapshot.threads.open}, active=${snapshot.threads.active}, blocked=${snapshot.threads.blocked}, done=${snapshot.threads.done})`,
    `claims(active=${snapshot.claims.active})`,
    `primitives(total=${snapshot.primitives.total}, types=${Object.keys(snapshot.primitives.byType).length})`,
    `triggers(total=${snapshot.triggers.total}, active=${snapshot.triggers.active}, approved=${snapshot.triggers.approved})`,
  ].join(' ');
}
