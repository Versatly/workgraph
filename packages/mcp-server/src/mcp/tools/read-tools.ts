import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  graph as graphModule,
  ledger as ledgerModule,
  orientation as orientationModule,
  query as queryModule,
  registry as registryModule,
  store as storeModule,
  thread as threadModule,
  threadAudit as threadAuditModule,
} from '@versatly/workgraph-kernel';
import { resolveActor } from '../auth.js';
import { errorResult, okResult, renderStatusSummary } from '../result.js';
import { type WorkgraphMcpServerOptions } from '../types.js';

const graph = graphModule;
const ledger = ledgerModule;
const orientation = orientationModule;
const query = queryModule;
const registry = registryModule;
const store = storeModule;
const thread = threadModule;
const threadAudit = threadAuditModule;

export function registerReadTools(server: McpServer, options: WorkgraphMcpServerOptions): void {
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
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
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
    'workgraph_primitive_schema',
    {
      title: 'Primitive Schema',
      description: 'Return field schema and metadata for a primitive type.',
      inputSchema: {
        typeName: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const typeDef = registry.getType(options.workspacePath, args.typeName);
        if (!typeDef) {
          return errorResult(`Unknown primitive type "${args.typeName}".`);
        }
        const fields = Object.entries(typeDef.fields).map(([name, definition]) => ({
          name,
          type: definition.type,
          required: definition.required === true,
          default: definition.default,
          enum: definition.enum ?? [],
          description: definition.description ?? '',
          template: definition.template ?? undefined,
          pattern: definition.pattern ?? undefined,
          refTypes: definition.refTypes ?? [],
        }));
        return okResult(
          {
            type: typeDef.name,
            description: typeDef.description,
            directory: typeDef.directory,
            builtIn: typeDef.builtIn,
            fields,
          },
          `Primitive schema for ${typeDef.name}.`,
        );
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
    'workgraph_ledger_reconcile',
    {
      title: 'Ledger Reconcile',
      description: 'Audit thread files against ledger claims, leases, and dependency wiring.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const report = threadAudit.reconcileThreadState(options.workspacePath);
        return okResult(
          report,
          `Ledger reconcile ${report.ok ? 'ok' : 'issues'}: ${report.issues.length} issue(s) across ${report.totalThreads} thread(s).`,
        );
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
}
