import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  agent as agentModule,
  autonomy as autonomyModule,
  cursorBridge as cursorBridgeModule,
  dispatch as dispatchModule,
  mission as missionModule,
  missionOrchestrator as missionOrchestratorModule,
  orientation as orientationModule,
  store as storeModule,
  transport as transportModule,
  threadContext as threadContextModule,
  thread as threadModule,
  trigger as triggerModule,
  triggerEngine as triggerEngineModule,
} from '@versatly/workgraph-kernel';
import { checkWriteGate, resolveActor } from '../auth.js';
import { errorResult, okResult } from '../result.js';
import { type WorkgraphMcpServerOptions } from '../types.js';

const agent = agentModule;
const autonomy = autonomyModule;
const cursorBridge = cursorBridgeModule;
const dispatch = dispatchModule;
const mission = missionModule;
const missionOrchestrator = missionOrchestratorModule;
const orientation = orientationModule;
const store = storeModule;
const transport = transportModule;
const threadContext = threadContextModule;
const thread = threadModule;
const trigger = triggerModule;
const triggerEngine = triggerEngineModule;

const missionFeatureInputSchema = z.union([
  z.string().min(1),
  z.object({
    title: z.string().min(1),
    goal: z.string().min(1).optional(),
    threadPath: z.string().min(1).optional(),
    priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
    deps: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  }),
]);

const missionMilestoneInputSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  deps: z.array(z.string()).optional(),
  features: z.array(missionFeatureInputSchema).min(1),
  validation: z.object({
    strategy: z.enum(['automated', 'manual', 'hybrid']).optional(),
    criteria: z.array(z.string()).optional(),
  }).optional(),
});

const triggerConditionSchema = z.union([
  z.string(),
  z.object({}).passthrough(),
]);

const triggerContextSchema = z.object({}).passthrough();

export function registerWriteTools(server: McpServer, options: WorkgraphMcpServerOptions): void {
  server.registerTool(
    'workgraph_agent_register',
    {
      title: 'Agent Register',
      description: 'Register an agent using trust-token fallback flow.',
      inputSchema: {
        name: z.string().min(1),
        actor: z.string().optional(),
        token: z.string().optional(),
        role: z.string().optional(),
        capabilities: z.array(z.string()).optional(),
        status: z.enum(['online', 'busy', 'offline']).optional(),
        currentTask: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['mcp:write'], {
          action: 'mcp.agent.register',
          target: 'agents',
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const token = typeof args.token === 'string' && args.token.trim().length > 0
          ? args.token.trim()
          : process.env.WORKGRAPH_TRUST_TOKEN;
        if (!token) {
          return errorResult('Missing trust token. Provide token argument or set WORKGRAPH_TRUST_TOKEN.');
        }
        const registered = agent.registerAgent(options.workspacePath, args.name, {
          token,
          role: args.role,
          capabilities: args.capabilities,
          status: args.status,
          currentTask: args.currentTask,
          actor: args.actor,
        });
        return okResult(registered, `Registered agent ${registered.agentName}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_agent_heartbeat',
    {
      title: 'Agent Heartbeat',
      description: 'Create/update an agent presence heartbeat.',
      inputSchema: {
        name: z.string().min(1),
        actor: z.string().optional(),
        status: z.enum(['online', 'busy', 'offline']).optional(),
        currentTask: z.string().optional(),
        capabilities: z.array(z.string()).optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['agent:heartbeat', 'mcp:write'], {
          action: 'mcp.agent.heartbeat',
          target: args.name,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const presence = agent.heartbeat(options.workspacePath, args.name, {
          actor: args.actor,
          status: args.status,
          currentTask: args.currentTask,
          capabilities: args.capabilities,
        });
        return okResult({ presence }, `Heartbeated agent ${args.name}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_create_mission',
    {
      title: 'Mission Create',
      description: 'Create a mission primitive in planning status.',
      inputSchema: {
        title: z.string().min(1),
        goal: z.string().min(1),
        actor: z.string().optional(),
        mid: z.string().min(1).optional(),
        description: z.string().optional(),
        priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
        owner: z.string().optional(),
        project: z.string().optional(),
        space: z.string().optional(),
        constraints: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['mission:create', 'mcp:write'], {
          action: 'mcp.mission.create',
          target: 'missions',
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const created = mission.createMission(options.workspacePath, args.title, args.goal, actor, {
          mid: args.mid,
          description: args.description,
          priority: args.priority,
          owner: args.owner,
          project: args.project,
          space: args.space,
          constraints: args.constraints,
          tags: args.tags,
        });
        return okResult({ mission: created }, `Created mission ${created.path}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_plan_mission',
    {
      title: 'Mission Plan',
      description: 'Define or update mission milestones and feature threads.',
      inputSchema: {
        missionRef: z.string().min(1),
        actor: z.string().optional(),
        goal: z.string().optional(),
        constraints: z.array(z.string()).optional(),
        estimatedRuns: z.number().int().min(0).optional(),
        estimatedCostUsd: z.number().min(0).nullable().optional(),
        replaceMilestones: z.boolean().optional(),
        milestones: z.array(missionMilestoneInputSchema).min(1),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['mission:update', 'thread:create', 'mcp:write'], {
          action: 'mcp.mission.plan',
          target: args.missionRef,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const updated = mission.planMission(options.workspacePath, args.missionRef, {
          goal: args.goal,
          constraints: args.constraints,
          estimated_runs: args.estimatedRuns,
          estimated_cost_usd: args.estimatedCostUsd,
          replaceMilestones: args.replaceMilestones,
          milestones: args.milestones,
        }, actor);
        return okResult({ mission: updated }, `Planned mission ${updated.path}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_approve_mission',
    {
      title: 'Mission Approve',
      description: 'Approve a mission plan and move it to approved status.',
      inputSchema: {
        missionRef: z.string().min(1),
        actor: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['mission:update', 'mcp:write'], {
          action: 'mcp.mission.approve',
          target: args.missionRef,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const updated = mission.approveMission(options.workspacePath, args.missionRef, actor);
        return okResult({ mission: updated }, `Approved mission ${updated.path}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_start_mission',
    {
      title: 'Mission Start',
      description: 'Start mission execution and run one orchestrator cycle.',
      inputSchema: {
        missionRef: z.string().min(1),
        actor: z.string().optional(),
        runCycle: z.boolean().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['mission:update', 'dispatch:run', 'mcp:write'], {
          action: 'mcp.mission.start',
          target: args.missionRef,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const updated = mission.startMission(options.workspacePath, args.missionRef, actor);
        const cycle = args.runCycle === false
          ? null
          : missionOrchestrator.runMissionOrchestratorCycle(options.workspacePath, updated.path, actor);
        return okResult({ mission: updated, cycle }, `Started mission ${updated.path}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_intervene_mission',
    {
      title: 'Mission Intervene',
      description: 'Apply mission intervention updates (priority/status/skip/append milestones).',
      inputSchema: {
        missionRef: z.string().min(1),
        actor: z.string().optional(),
        reason: z.string().min(1),
        setPriority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
        setStatus: z.enum(['planning', 'approved', 'active', 'validating', 'completed', 'failed']).optional(),
        skipFeature: z.object({
          milestoneId: z.string().min(1),
          threadPath: z.string().min(1),
        }).optional(),
        appendMilestones: z.array(missionMilestoneInputSchema).optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['mission:update', 'thread:update', 'mcp:write'], {
          action: 'mcp.mission.intervene',
          target: args.missionRef,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const updated = mission.interveneMission(options.workspacePath, args.missionRef, {
          reason: args.reason,
          setPriority: args.setPriority,
          setStatus: args.setStatus,
          skipFeature: args.skipFeature,
          appendMilestones: args.appendMilestones,
        }, actor);
        return okResult({ mission: updated }, `Intervened mission ${updated.path}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_thread_create',
    {
      title: 'Thread Create',
      description: 'Create a new thread primitive (policy-scoped write).',
      inputSchema: {
        title: z.string().min(1),
        goal: z.string().min(1),
        actor: z.string().optional(),
        priority: z.string().optional(),
        deps: z.array(z.string()).optional(),
        parent: z.string().optional(),
        space: z.string().optional(),
        context_refs: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['thread:create', 'mcp:write'], {
          action: 'mcp.thread.create',
          target: 'threads',
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const created = thread.createThread(options.workspacePath, args.title, args.goal, actor, {
          priority: args.priority,
          deps: args.deps,
          parent: args.parent,
          space: args.space,
          context_refs: args.context_refs,
          tags: args.tags,
        });
        return okResult({ thread: created }, `Created thread ${created.path}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_thread_block',
    {
      title: 'Thread Block',
      description: 'Mark a thread blocked with a reason (policy-scoped write).',
      inputSchema: {
        threadPath: z.string().min(1),
        actor: z.string().optional(),
        reason: z.string().min(1),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['thread:update', 'mcp:write'], {
          action: 'mcp.thread.block',
          target: args.threadPath,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const updated = thread.block(options.workspacePath, args.threadPath, actor, 'external/manual', args.reason);
        return okResult({ thread: updated }, `Blocked ${updated.path} as ${actor}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_thread_unblock',
    {
      title: 'Thread Unblock',
      description: 'Unblock a blocked thread (policy-scoped write).',
      inputSchema: {
        threadPath: z.string().min(1),
        actor: z.string().optional(),
        reason: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['thread:update', 'mcp:write'], {
          action: 'mcp.thread.unblock',
          target: args.threadPath,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const updated = thread.unblock(options.workspacePath, args.threadPath, actor);
        const reasonSuffix = args.reason ? ` Reason: ${args.reason}` : '';
        return okResult({ thread: updated }, `Unblocked ${updated.path} as ${actor}.${reasonSuffix}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_thread_handoff',
    {
      title: 'Thread Handoff',
      description: 'Hand off a claimed thread to another actor (policy-scoped write).',
      inputSchema: {
        threadPath: z.string().min(1),
        actor: z.string().optional(),
        fromActor: z.string().optional(),
        toActor: z.string().min(1),
        reason: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const fromActor = resolveActor(options.workspacePath, args.fromActor, actor);
        const gate = checkWriteGate(options, fromActor, ['thread:update', 'mcp:write'], {
          action: 'mcp.thread.handoff',
          target: args.threadPath,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const updated = thread.handoff(options.workspacePath, args.threadPath, fromActor, args.toActor, args.reason);
        return okResult({ thread: updated }, `Handed off ${updated.path} from ${fromActor} to ${args.toActor}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_thread_release',
    {
      title: 'Thread Release',
      description: 'Release a claimed thread back to open (policy-scoped write).',
      inputSchema: {
        threadPath: z.string().min(1),
        actor: z.string().optional(),
        reason: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['thread:claim', 'mcp:write'], {
          action: 'mcp.thread.release',
          target: args.threadPath,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const updated = thread.release(options.workspacePath, args.threadPath, actor, args.reason);
        return okResult({ thread: updated }, `Released ${updated.path} as ${actor}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_thread_heartbeat',
    {
      title: 'Thread Heartbeat',
      description: 'Refresh heartbeat metadata for a claimed thread (policy-scoped write).',
      inputSchema: {
        threadPath: z.string().min(1),
        actor: z.string().optional(),
        note: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['thread:update', 'mcp:write'], {
          action: 'mcp.thread.heartbeat',
          target: args.threadPath,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const updated = thread.heartbeat(options.workspacePath, args.threadPath, actor);
        return okResult(
          {
            thread: updated,
            ...(args.note ? { note: args.note } : {}),
          },
          `Heartbeated ${updated.path} as ${actor}.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_thread_join',
    {
      title: 'Thread Join',
      description: 'Join a thread as a participant (policy-scoped write).',
      inputSchema: {
        threadPath: z.string().min(1),
        actor: z.string().optional(),
        role: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['thread:update', 'mcp:write'], {
          action: 'mcp.thread.join',
          target: args.threadPath,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const role = args.role === 'participant' ? 'contributor' : args.role;
        const updated = thread.joinThread(
          options.workspacePath,
          args.threadPath,
          actor,
          role as Parameters<typeof thread.joinThread>[3],
        );
        return okResult({ thread: updated }, `Joined ${updated.path} as ${actor}.`);
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
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['thread:claim', 'mcp:write'], {
          action: 'mcp.thread.claim',
          target: args.threadPath,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const updated = thread.claim(options.workspacePath, args.threadPath, actor);
        const contextSummary = threadContext.summarizeThreadContext(options.workspacePath, updated.path, { topN: 3 });
        return okResult(
          {
            thread: updated,
            context: contextSummary,
          },
          `Claimed ${updated.path} as ${actor}.`,
        );
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
        reason: z.string().optional(),
        evidence: z.array(z.string()).optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['thread:done', 'mcp:write'], {
          action: 'mcp.thread.done',
          target: args.threadPath,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const output = args.reason
          ? [args.output, `Reason: ${args.reason}`].filter((entry): entry is string => Boolean(entry)).join('\n\n')
          : args.output;
        const updated = thread.done(options.workspacePath, args.threadPath, actor, output, {
          evidence: args.evidence,
        });
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
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['checkpoint:create', 'mcp:write'], {
          action: 'mcp.checkpoint.create',
          target: 'checkpoints',
        });
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
    'workgraph_create_decision',
    {
      title: 'Decision Create',
      description: 'Create a decision primitive with rationale, participants, and alternatives.',
      inputSchema: {
        title: z.string().min(1),
        actor: z.string().optional(),
        status: z.enum(['draft', 'proposed', 'approved', 'active', 'superseded', 'reverted']).optional(),
        date: z.string().optional(),
        decidedBy: z.string().optional(),
        participants: z.array(z.string()).optional(),
        alternatives: z.array(z.string()).optional(),
        rationale: z.string().optional(),
        consequences: z.array(z.string()).optional(),
        supersedes: z.string().optional(),
        relatedRefs: z.array(z.string()).optional(),
        externalLinks: z.array(z.string()).optional(),
        contextRefs: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        body: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['mcp:write'], {
          action: 'mcp.decision.create',
          target: 'decisions',
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const decision = store.create(
          options.workspacePath,
          'decision',
          {
            title: args.title,
            date: args.date ?? new Date().toISOString(),
            status: args.status,
            decided_by: args.decidedBy ?? actor,
            participants: args.participants ?? [],
            alternatives: args.alternatives ?? [],
            rationale: args.rationale,
            consequences: args.consequences ?? [],
            supersedes: args.supersedes,
            related_refs: args.relatedRefs ?? [],
            external_links: args.externalLinks ?? [],
            context_refs: args.contextRefs ?? [],
            tags: args.tags ?? [],
          },
          args.body ?? '',
          actor,
        );
        return okResult({ decision }, `Created decision ${decision.path}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_record_lesson',
    {
      title: 'Lesson Record',
      description: 'Record a lesson with severity and source event context.',
      inputSchema: {
        title: z.string().min(1),
        actor: z.string().optional(),
        date: z.string().optional(),
        confidence: z.string().optional(),
        severity: z.enum(['critical', 'important', 'minor']).optional(),
        sourceEvent: z.string().optional(),
        appliesTo: z.array(z.string()).optional(),
        relatedRefs: z.array(z.string()).optional(),
        contextRefs: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        body: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['mcp:write'], {
          action: 'mcp.lesson.record',
          target: 'lessons',
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const lesson = store.create(
          options.workspacePath,
          'lesson',
          {
            title: args.title,
            date: args.date ?? new Date().toISOString(),
            confidence: args.confidence,
            severity: args.severity,
            source_event: args.sourceEvent,
            applies_to: args.appliesTo ?? [],
            related_refs: args.relatedRefs ?? [],
            context_refs: args.contextRefs ?? [],
            tags: args.tags ?? [],
          },
          args.body ?? '',
          actor,
        );
        return okResult({ lesson }, `Recorded lesson ${lesson.path}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_record_pattern',
    {
      title: 'Pattern Record',
      description: 'Record a reusable pattern with steps and exceptions.',
      inputSchema: {
        title: z.string().min(1),
        actor: z.string().optional(),
        description: z.string().optional(),
        steps: z.array(z.string()).optional(),
        exceptions: z.array(z.string()).optional(),
        appliesTo: z.array(z.string()).optional(),
        relatedRefs: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        body: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['mcp:write'], {
          action: 'mcp.pattern.record',
          target: 'patterns',
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const pattern = store.create(
          options.workspacePath,
          'pattern',
          {
            title: args.title,
            description: args.description,
            steps: args.steps ?? [],
            exceptions: args.exceptions ?? [],
            applies_to: args.appliesTo ?? [],
            related_refs: args.relatedRefs ?? [],
            tags: args.tags ?? [],
          },
          args.body ?? '',
          actor,
        );
        return okResult({ pattern }, `Recorded pattern ${pattern.path}.`);
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
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['dispatch:run', 'mcp:write'], {
          action: 'mcp.dispatch.create',
          target: '.workgraph/dispatch-runs',
        });
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
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['dispatch:run', 'mcp:write'], {
          action: 'mcp.dispatch.execute',
          target: `.workgraph/runs/${args.runId}`,
        });
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
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['dispatch:run', 'mcp:write'], {
          action: 'mcp.dispatch.followup',
          target: `.workgraph/runs/${args.runId}`,
        });
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
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['dispatch:run', 'mcp:write'], {
          action: 'mcp.dispatch.stop',
          target: `.workgraph/runs/${args.runId}`,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const run = dispatch.stop(options.workspacePath, args.runId, actor);
        return okResult({ run }, `Stopped run ${run.id}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_trigger_create',
    {
      title: 'Trigger Create',
      description: 'Create a trigger primitive with programmable condition/action payloads.',
      inputSchema: {
        actor: z.string().optional(),
        name: z.string().min(1),
        type: z.enum(['cron', 'webhook', 'event', 'manual']),
        condition: triggerConditionSchema.optional(),
        action: triggerConditionSchema.optional(),
        enabled: z.boolean().optional(),
        cooldown: z.number().int().min(0).optional(),
        body: z.string().optional(),
        tags: z.array(z.string()).optional(),
        path: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['dispatch:run', 'promote:trigger', 'mcp:write'], {
          action: 'mcp.trigger.create',
          target: 'triggers',
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const created = trigger.createTrigger(options.workspacePath, {
          actor,
          name: args.name,
          type: args.type,
          condition: args.condition,
          action: args.action,
          enabled: args.enabled,
          cooldown: args.cooldown,
          body: args.body,
          tags: args.tags,
          path: args.path,
        });
        return okResult({ trigger: created }, `Created trigger ${created.path}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_trigger_update',
    {
      title: 'Trigger Update',
      description: 'Update trigger metadata or programmable condition/action payloads.',
      inputSchema: {
        actor: z.string().optional(),
        triggerRef: z.string().min(1),
        name: z.string().optional(),
        type: z.enum(['cron', 'webhook', 'event', 'manual']).optional(),
        condition: triggerConditionSchema.optional(),
        action: triggerConditionSchema.optional(),
        enabled: z.boolean().optional(),
        cooldown: z.number().int().min(0).optional(),
        body: z.string().optional(),
        tags: z.array(z.string()).optional(),
        lastFired: z.string().nullable().optional(),
        nextFireAt: z.string().nullable().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['dispatch:run', 'promote:trigger', 'mcp:write'], {
          action: 'mcp.trigger.update',
          target: args.triggerRef,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const updated = trigger.updateTrigger(options.workspacePath, args.triggerRef, {
          actor,
          name: args.name,
          type: args.type,
          condition: args.condition,
          action: args.action,
          enabled: args.enabled,
          cooldown: args.cooldown,
          body: args.body,
          tags: args.tags,
          lastFired: args.lastFired,
          nextFireAt: args.nextFireAt,
        });
        return okResult({ trigger: updated }, `Updated trigger ${updated.path}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_trigger_delete',
    {
      title: 'Trigger Delete',
      description: 'Delete a trigger primitive.',
      inputSchema: {
        actor: z.string().optional(),
        triggerRef: z.string().min(1),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['dispatch:run', 'mcp:write'], {
          action: 'mcp.trigger.delete',
          target: args.triggerRef,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        trigger.deleteTrigger(options.workspacePath, args.triggerRef, actor);
        return okResult({ deleted: true, triggerRef: args.triggerRef }, `Deleted trigger ${args.triggerRef}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_trigger_fire',
    {
      title: 'Trigger Fire',
      description: 'Manually fire a trigger into a dispatch run, optionally executing it immediately.',
      inputSchema: {
        actor: z.string().optional(),
        triggerRef: z.string().min(1),
        eventKey: z.string().optional(),
        objective: z.string().optional(),
        adapter: z.string().optional(),
        context: triggerContextSchema.optional(),
        execute: z.boolean().optional(),
        retryFailed: z.boolean().optional(),
        agents: z.array(z.string()).optional(),
        maxSteps: z.number().int().min(1).max(5000).optional(),
        stepDelayMs: z.number().int().min(0).max(5000).optional(),
        space: z.string().optional(),
        createCheckpoint: z.boolean().optional(),
        timeoutMs: z.number().int().min(1).max(60 * 60_000).optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['dispatch:run', 'mcp:write'], {
          action: 'mcp.trigger.fire',
          target: args.triggerRef,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const fired = await trigger.fireTriggerAndExecute(options.workspacePath, args.triggerRef, {
          actor,
          eventKey: args.eventKey,
          objective: args.objective,
          adapter: args.adapter,
          context: args.context,
          execute: args.execute,
          retryFailed: args.retryFailed,
          executeInput: {
            agents: args.agents,
            maxSteps: args.maxSteps,
            stepDelayMs: args.stepDelayMs,
            space: args.space,
            createCheckpoint: args.createCheckpoint,
            timeoutMs: args.timeoutMs,
          },
        });
        return okResult(fired, `Fired trigger ${fired.triggerPath} into run ${fired.run.id}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_trigger_engine_cycle',
    {
      title: 'Trigger Engine Cycle',
      description: 'Process trigger events from ledger with idempotent cursor tracking.',
      inputSchema: {
        actor: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['dispatch:run', 'mcp:write'], {
          action: 'mcp.trigger.cycle',
          target: '.workgraph/trigger-state.json',
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const result = triggerEngine.runTriggerEngineCycle(options.workspacePath, {
          actor,
        });
        return okResult(
          result,
          `Trigger cycle evaluated ${result.evaluated} triggers, fired ${result.fired} action(s).`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_autonomy_run',
    {
      title: 'Autonomy Run',
      description: 'Run autonomous collaboration cycles with drift checks.',
      inputSchema: {
        actor: z.string().optional(),
        adapter: z.string().optional(),
        agents: z.array(z.string()).optional(),
        maxCycles: z.number().int().min(1).max(10_000).optional(),
        maxIdleCycles: z.number().int().min(1).max(1_000).optional(),
        pollMs: z.number().int().min(1).max(60_000).optional(),
        watch: z.boolean().optional(),
        maxSteps: z.number().int().min(1).max(5000).optional(),
        stepDelayMs: z.number().int().min(0).max(5000).optional(),
        executeTriggers: z.boolean().optional(),
        executeReadyThreads: z.boolean().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['dispatch:run', 'mcp:write'], {
          action: 'mcp.autonomy.run',
          target: '.workgraph/autonomy',
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const result = await autonomy.runAutonomyLoop(options.workspacePath, {
          actor,
          adapter: args.adapter,
          agents: args.agents,
          maxCycles: args.maxCycles,
          maxIdleCycles: args.maxIdleCycles,
          pollMs: args.pollMs,
          watch: args.watch,
          maxSteps: args.maxSteps,
          stepDelayMs: args.stepDelayMs,
          executeTriggers: args.executeTriggers,
          executeReadyThreads: args.executeReadyThreads,
        });
        return okResult(
          result,
          `Autonomy completed ${result.cycles.length} cycle(s); final ready threads=${result.finalReadyThreads}.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'wg_transport_replay',
    {
      title: 'Transport Replay',
      description: 'Replay an outbox or dead-letter transport delivery.',
      inputSchema: {
        actor: z.string().optional(),
        recordType: z.enum(['outbox', 'dead-letter']),
        id: z.string().min(1),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['dispatch:run', 'mcp:write'], {
          action: 'mcp.transport.replay',
          target: `.workgraph/transport/${args.recordType}/${args.id}`,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const replayed = await replayTransportRecord(options.workspacePath, args.recordType, args.id);
        return okResult(
          replayed,
          `Replayed ${args.recordType} transport record ${args.id}.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

async function replayTransportRecord(
  workspacePath: string,
  recordType: 'outbox' | 'dead-letter',
  id: string,
) {
  const outbox = recordType === 'outbox'
    ? transport.readTransportOutboxRecord(workspacePath, id)
    : resolveDeadLetterSourceOutbox(workspacePath, id);
  if (!outbox) {
    throw new Error(`Transport record not found or not replayable: ${recordType}/${id}`);
  }
  const replayed = await transport.replayTransportOutboxRecord(workspacePath, outbox.id, async (record) => {
    if (record.deliveryHandler === 'dashboard-webhook') {
      await replayDashboardWebhook(record);
      return;
    }
    if (record.deliveryHandler === 'runtime-bridge') {
      await replayRuntimeBridge(workspacePath, record);
      return;
    }
    if (record.deliveryHandler === 'trigger-action') {
      await replayTriggerAction(workspacePath, record);
      return;
    }
    throw new Error(`Unsupported transport replay handler "${record.deliveryHandler}".`);
  });
  if (!replayed) {
    throw new Error(`Transport outbox record not found: ${outbox.id}`);
  }
  if (recordType === 'dead-letter') {
    transport.markTransportDeadLetterReplayed(workspacePath, id);
  }
  return replayed;
}

function resolveDeadLetterSourceOutbox(
  workspacePath: string,
  id: string,
) {
  const deadLetter = transport.readTransportDeadLetter(workspacePath, id);
  if (!deadLetter) return null;
  if (deadLetter.sourceRecordType !== 'outbox') {
    throw new Error(`Dead-letter record ${id} is not replayable from source type "${deadLetter.sourceRecordType}".`);
  }
  return transport.readTransportOutboxRecord(workspacePath, deadLetter.sourceRecordId);
}

async function replayDashboardWebhook(record: ReturnType<typeof transport.readTransportOutboxRecord> extends infer T ? Exclude<T, null> : never): Promise<void> {
  const payload = record.envelope.payload;
  const request = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).request : undefined;
  const requestRecord = request && typeof request === 'object' ? request as Record<string, unknown> : {};
  const url = typeof requestRecord.url === 'string' ? requestRecord.url : record.deliveryTarget;
  const method = typeof requestRecord.method === 'string' ? requestRecord.method : 'POST';
  const headers = requestRecord.headers && typeof requestRecord.headers === 'object'
    ? requestRecord.headers as Record<string, string>
    : { 'content-type': 'application/json' };
  const body = typeof requestRecord.body === 'string'
    ? requestRecord.body
    : JSON.stringify(record.envelope.payload);
  const response = await fetch(url, {
    method,
    headers,
    body,
  });
  if (!response.ok) {
    throw new Error(`Dashboard webhook replay failed (${response.status}).`);
  }
}

async function replayRuntimeBridge(
  workspacePath: string,
  record: ReturnType<typeof transport.readTransportOutboxRecord> extends infer T ? Exclude<T, null> : never,
): Promise<void> {
  const payload = record.envelope.payload;
  await cursorBridge.dispatchCursorAutomationEvent(workspacePath, {
    source: (payload.source as 'webhook' | 'cli-dispatch' | undefined) ?? 'cli-dispatch',
    eventId: typeof payload.eventId === 'string' ? payload.eventId : undefined,
    eventType: typeof payload.eventType === 'string' ? payload.eventType : undefined,
    objective: typeof payload.objective === 'string' ? payload.objective : undefined,
    actor: typeof payload.actor === 'string' ? payload.actor : undefined,
    adapter: typeof payload.adapter === 'string' ? payload.adapter : undefined,
    execute: typeof payload.execute === 'boolean' ? payload.execute : undefined,
    context: payload.context && typeof payload.context === 'object' && !Array.isArray(payload.context)
      ? payload.context as Record<string, unknown>
      : undefined,
  });
}

async function replayTriggerAction(
  workspacePath: string,
  record: ReturnType<typeof transport.readTransportOutboxRecord> extends infer T ? Exclude<T, null> : never,
): Promise<void> {
  const payload = record.envelope.payload;
  triggerEngine.replayTriggerActionDelivery(workspacePath, {
    triggerPath: typeof payload.triggerPath === 'string' ? payload.triggerPath : record.deliveryTarget,
    action: payload.action && typeof payload.action === 'object' && !Array.isArray(payload.action)
      ? payload.action as Record<string, unknown>
      : {},
    context: payload.context && typeof payload.context === 'object' && !Array.isArray(payload.context)
      ? payload.context as Record<string, unknown>
      : {},
    actor: typeof payload.actor === 'string' ? payload.actor : 'system',
    eventKey: typeof payload.eventKey === 'string' ? payload.eventKey : undefined,
  });
}
