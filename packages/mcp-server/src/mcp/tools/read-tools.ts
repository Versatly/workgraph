import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  federation as federationModule,
  graph as graphModule,
  ledger as ledgerModule,
  mission as missionModule,
  orientation as orientationModule,
  projections as projectionsModule,
  query as queryModule,
  registry as registryModule,
  store as storeModule,
  transport as transportModule,
  thread as threadModule,
  threadAudit as threadAuditModule,
} from '@versatly/workgraph-kernel';
import { resolveActor } from '../auth.js';
import { errorResult, okResult, renderStatusSummary } from '../result.js';
import { type WorkgraphMcpServerOptions } from '../types.js';

const federation = federationModule;
const graph = graphModule;
const ledger = ledgerModule;
const mission = missionModule;
const orientation = orientationModule;
const projections = projectionsModule;
const query = queryModule;
const registry = registryModule;
const store = storeModule;
const transport = transportModule;
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
    'workgraph_mission_status',
    {
      title: 'Mission Status',
      description: 'Read one mission primitive and computed progress.',
      inputSchema: {
        missionRef: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const missionInstance = mission.missionStatus(options.workspacePath, args.missionRef);
        const progress = mission.missionProgress(options.workspacePath, missionInstance.path);
        return okResult(
          { mission: missionInstance, progress },
          `Mission ${missionInstance.path} is ${String(missionInstance.fields.status)}.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_mission_progress',
    {
      title: 'Mission Progress',
      description: 'Read aggregate mission progress across milestones and features.',
      inputSchema: {
        missionRef: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const progress = mission.missionProgress(options.workspacePath, args.missionRef);
        return okResult(
          progress,
          `Mission progress ${progress.mid}: ${progress.percentComplete}% (${progress.doneFeatures}/${progress.totalFeatures} features).`,
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
    'wg_transport_outbox_list',
    {
      title: 'Transport Outbox List',
      description: 'List persistent outbound transport records.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const records = transport.listTransportOutbox(options.workspacePath);
        return okResult({ records, count: records.length }, `Transport outbox has ${records.length} record(s).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'wg_transport_inbox_list',
    {
      title: 'Transport Inbox List',
      description: 'List persistent inbound transport records.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const records = transport.listTransportInbox(options.workspacePath);
        return okResult({ records, count: records.length }, `Transport inbox has ${records.length} record(s).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'wg_transport_dead_letter_list',
    {
      title: 'Transport Dead Letter List',
      description: 'List failed transport deliveries available for inspection and replay.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const records = transport.listTransportDeadLetters(options.workspacePath);
        return okResult({ records, count: records.length }, `Transport dead-letter queue has ${records.length} record(s).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'wg_federation_status',
    {
      title: 'Federation Status',
      description: 'Read workspace federation identity and remote handshake status.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const status = federation.federationStatus(options.workspacePath);
        return okResult(status, `Federation status loaded for ${status.remotes.length} remote(s).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'wg_federation_resolve_ref',
    {
      title: 'Federation Resolve Ref',
      description: 'Resolve one typed or legacy federated reference with authority and staleness metadata.',
      inputSchema: {
        ref: z.union([z.string().min(1), z.object({}).passthrough()]),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const resolved = federation.resolveFederatedRef(options.workspacePath, args.ref as any);
        return okResult(
          resolved,
          `Resolved federated ref to ${resolved.source}:${resolved.instance.path} (authority=${resolved.authority}).`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'wg_federation_search',
    {
      title: 'Federation Search',
      description: 'Search local and remote workspaces through read-only federation capability negotiation.',
      inputSchema: {
        query: z.string().min(1),
        type: z.string().optional(),
        limit: z.number().int().min(0).max(1000).optional(),
        remoteIds: z.array(z.string()).optional(),
        includeLocal: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const result = federation.searchFederated(options.workspacePath, args.query, {
          type: args.type,
          limit: args.limit,
          remoteIds: args.remoteIds,
          includeLocal: args.includeLocal,
        });
        return okResult(
          result,
          `Federation search returned ${result.results.length} result(s) with ${result.errors.length} remote error(s).`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'wg_run_health',
    {
      title: 'Run Health Projection',
      description: 'Return the run health projection.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const projection = projections.buildRunHealthProjection(options.workspacePath);
        return okResult(projection, `Run health: active=${projection.summary.activeRuns}, stale=${projection.summary.staleRuns}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'wg_risk_dashboard',
    {
      title: 'Risk Dashboard Projection',
      description: 'Return the risk dashboard projection.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const projection = projections.buildRiskDashboardProjection(options.workspacePath);
        return okResult(projection, `Risk dashboard: blocked=${projection.summary.blockedThreads}, violations=${projection.summary.policyViolations}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'wg_mission_progress_projection',
    {
      title: 'Mission Progress Projection',
      description: 'Return the mission progress projection.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const projection = projections.buildMissionProgressProjection(options.workspacePath);
        return okResult(projection, `Mission progress projection covers ${projection.summary.totalMissions} mission(s).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'wg_transport_health',
    {
      title: 'Transport Health Projection',
      description: 'Return the transport health projection.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const projection = projections.buildTransportHealthProjection(options.workspacePath);
        return okResult(projection, `Transport health: outbox=${projection.summary.outboxDepth}, dead-letter=${projection.summary.deadLetterCount}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'wg_federation_status_projection',
    {
      title: 'Federation Status Projection',
      description: 'Return the federation status projection.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const projection = projections.buildFederationStatusProjection(options.workspacePath);
        return okResult(projection, `Federation projection covers ${projection.summary.remotes} remote(s).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'wg_trigger_health',
    {
      title: 'Trigger Health Projection',
      description: 'Return the trigger health projection.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const projection = projections.buildTriggerHealthProjection(options.workspacePath);
        return okResult(projection, `Trigger health: total=${projection.summary.totalTriggers}, errors=${projection.summary.errorTriggers}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'wg_autonomy_health',
    {
      title: 'Autonomy Health Projection',
      description: 'Return the autonomy health projection.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const projection = projections.buildAutonomyHealthProjection(options.workspacePath);
        return okResult(projection, `Autonomy health: running=${projection.summary.running}.`);
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
