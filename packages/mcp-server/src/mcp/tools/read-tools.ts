import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  agent as agentModule,
  contextGraphContract as contextGraphContractModule,
  graph as graphModule,
  ledger as ledgerModule,
  lens as lensModule,
  orientation as orientationModule,
  query as queryModule,
  registry as registryModule,
  store as storeModule,
  thread as threadModule,
} from '@versatly/workgraph-kernel';
import { resolveActor } from '../auth.js';
import { errorResult, okResult, renderStatusSummary } from '../result.js';
import { type WorkgraphMcpServerOptions } from '../types.js';

const agent = agentModule;
const contextGraphContract = contextGraphContractModule;
const graph = graphModule;
const ledger = ledgerModule;
const lens = lensModule;
const orientation = orientationModule;
const query = queryModule;
const registry = registryModule;
const store = storeModule;
const thread = threadModule;

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
      description: 'Return actor-centric operational brief for thread collaboration.',
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
    'workgraph_company_context',
    {
      title: 'Company Context',
      description: 'Return the current company context snapshot for an actor.',
      inputSchema: {
        actor: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const companyContext = orientation.companyContext(options.workspacePath, actor);
        return okResult(
          companyContext,
          `Company context for ${actor}: teams=${companyContext.teams.length}, decisions=${companyContext.recentDecisions.length}.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_agent_list',
    {
      title: 'Agent List',
      description: 'List known agent presence entries.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const agents = agent.list(options.workspacePath);
        return okResult({ agents, count: agents.length }, `Agent list returned ${agents.length} entry(s).`);
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
        const results = query.queryPrimitives(options.workspacePath, args);
        return okResult({ results, count: results.length }, `Query returned ${results.length} primitive(s).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_search',
    {
      title: 'Workgraph Search',
      description: 'Keyword search across markdown body/frontmatter.',
      inputSchema: {
        text: z.string().min(1),
        type: z.string().optional(),
        limit: z.number().int().min(0).max(1000).optional(),
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
          limit: args.limit,
        });
        return okResult({ results, count: results.length }, `Search returned ${results.length} result(s).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_lens_list',
    {
      title: 'Workgraph Lens List',
      description: 'List built-in context lenses.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const lenses = lens.listContextLenses();
        return okResult({ lenses, count: lenses.length }, `Lens list returned ${lenses.length} item(s).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_lens_show',
    {
      title: 'Workgraph Lens Show',
      description: 'Generate one context lens snapshot.',
      inputSchema: {
        lensId: z.string().min(1),
        actor: z.string().optional(),
        lookbackHours: z.number().positive().optional(),
        staleHours: z.number().positive().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        outputPath: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        if (args.outputPath) {
          const materialized = lens.materializeContextLens(options.workspacePath, args.lensId, {
            actor,
            lookbackHours: args.lookbackHours,
            staleHours: args.staleHours,
            limit: args.limit,
            outputPath: args.outputPath,
          });
          return okResult(materialized, `Materialized lens ${materialized.lens} to ${materialized.outputPath}.`);
        }
        const generated = lens.generateContextLens(options.workspacePath, args.lensId, {
          actor,
          lookbackHours: args.lookbackHours,
          staleHours: args.staleHours,
          limit: args.limit,
        });
        return okResult(generated, `Generated lens ${generated.lens}.`);
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
      description: 'List workspace threads, optionally filtered by status, readiness, or space.',
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
      description: 'Generate a wiki-link graph hygiene report.',
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
    'workgraph_context_graph_contract',
    {
      title: 'Context Graph Contract',
      description: 'Evaluate core context graph contract invariants for the current workspace.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const report = contextGraphContract.evaluateCoreContextGraphInvariants({
          registry: registry.loadRegistry(options.workspacePath),
          queryFilterKeys: ['type', 'status', 'owner', 'tag', 'text', 'pathIncludes', 'updatedAfter', 'updatedBefore', 'createdAfter', 'createdBefore', 'limit', 'offset'],
          lenses: lens.listContextLenses(),
        });
        return okResult(report, `Context graph contract ${report.ok ? 'passes' : 'has violations'} (${report.violations.length}).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
