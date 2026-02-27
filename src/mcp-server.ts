import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as dispatch from './dispatch.js';
import * as graph from './graph.js';
import * as ledger from './ledger.js';
import * as orientation from './orientation.js';
import * as policy from './policy.js';
import * as query from './query.js';
import * as store from './store.js';
import * as thread from './thread.js';

export interface WorkgraphMcpServerOptions {
  workspacePath: string;
  defaultActor?: string;
  readOnly?: boolean;
  name?: string;
  version?: string;
}

const DEFAULT_SERVER_NAME = 'workgraph-mcp-server';
const DEFAULT_SERVER_VERSION = '0.1.0';

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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
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
            text: toPrettyJson(snapshot),
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
        return okResult(snapshot, renderStatusSummary(snapshot));
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

function renderStatusSummary(snapshot: ReturnType<typeof orientation.statusSnapshot>): string {
  return [
    `threads(total=${snapshot.threads.total}, open=${snapshot.threads.open}, active=${snapshot.threads.active}, blocked=${snapshot.threads.blocked}, done=${snapshot.threads.done})`,
    `claims(active=${snapshot.claims.active})`,
    `primitives(total=${snapshot.primitives.total})`,
  ].join(' ');
}
