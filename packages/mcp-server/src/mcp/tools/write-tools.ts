import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  agent as agentModule,
  orientation as orientationModule,
  registry as registryModule,
  store as storeModule,
  thread as threadModule,
} from '@versatly/workgraph-kernel';
import { checkWriteGate, resolveActor } from '../auth.js';
import { errorResult, okResult } from '../result.js';
import { type WorkgraphMcpServerOptions } from '../types.js';

const agent = agentModule;
const orientation = orientationModule;
const registry = registryModule;
const store = storeModule;
const thread = threadModule;

const threadStatusSchema = z.enum(['open', 'active', 'blocked', 'done', 'cancelled']);
const agentStatusSchema = z.enum(['online', 'busy', 'offline']);

export function registerWriteTools(server: McpServer, options: WorkgraphMcpServerOptions): void {
  server.registerTool(
    'workgraph_agent_register',
    {
      title: 'Agent Register',
      description: 'Register an actor using the configured bootstrap token flow.',
      inputSchema: {
        name: z.string().min(1),
        actor: z.string().optional(),
        token: z.string().optional(),
        role: z.string().optional(),
        capabilities: z.array(z.string()).optional(),
        status: agentStatusSchema.optional(),
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
        const gate = checkWriteGate(options, actor, ['agent:register', 'mcp:write'], {
          action: 'mcp.agent.register',
          target: 'agents',
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const token = readNonEmptyString(args.token) ?? process.env.WORKGRAPH_TRUST_TOKEN;
        if (!token) {
          throw new Error('Missing trust token. Provide token argument or set WORKGRAPH_TRUST_TOKEN.');
        }
        const result = agent.registerAgent(options.workspacePath, args.name, {
          token,
          role: args.role,
          capabilities: args.capabilities,
          status: args.status,
          currentTask: args.currentTask,
          actor,
        });
        return okResult(result, `Registered agent ${result.agentName}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_agent_request_registration',
    {
      title: 'Agent Request Registration',
      description: 'Create a governed actor registration request.',
      inputSchema: {
        name: z.string().min(1),
        actor: z.string().optional(),
        role: z.string().optional(),
        capabilities: z.array(z.string()).optional(),
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
        if (options.readOnly) {
          return errorResult('MCP server is configured read-only; write tool is disabled.');
        }
        const result = agent.submitRegistrationRequest(options.workspacePath, args.name, {
          actor,
          role: args.role,
          capabilities: args.capabilities,
          note: args.note,
        });
        return okResult(result, `Created registration request for ${result.agentName}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_agent_list_registration_requests',
    {
      title: 'Agent List Registration Requests',
      description: 'List actor registration requests by status.',
      inputSchema: {
        actor: z.string().optional(),
        status: z.enum(['pending', 'approved', 'rejected']).optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const requests = agent.listRegistrationRequests(options.workspacePath, args.status);
        return okResult({ actor, status: args.status, requests, count: requests.length }, `Listed ${requests.length} registration request(s).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_agent_review_registration',
    {
      title: 'Agent Review Registration',
      description: 'Approve or reject a pending actor registration request.',
      inputSchema: {
        requestRef: z.string().min(1),
        actor: z.string().optional(),
        decision: z.enum(['approved', 'rejected']),
        role: z.string().optional(),
        capabilities: z.array(z.string()).optional(),
        scopes: z.array(z.string()).optional(),
        expiresAt: z.string().optional(),
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
        const gate = checkWriteGate(options, actor, ['agent:approve-registration', 'policy:manage', 'mcp:write'], {
          action: 'mcp.agent.review-registration',
          target: args.requestRef,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const result = agent.reviewRegistrationRequest(
          options.workspacePath,
          args.requestRef,
          actor,
          args.decision,
          {
            role: args.role,
            capabilities: args.capabilities,
            scopes: args.scopes,
            expiresAt: args.expiresAt,
            note: args.note,
          },
        );
        return okResult(result, `Registration request ${args.requestRef} reviewed as ${args.decision}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_agent_heartbeat',
    {
      title: 'Agent Heartbeat',
      description: 'Update actor presence and capabilities.',
      inputSchema: {
        name: z.string().min(1),
        actor: z.string().optional(),
        status: agentStatusSchema.optional(),
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
          actor,
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
    'workgraph_thread_create',
    {
      title: 'Thread Create',
      description: 'Create a new collaboration thread.',
      inputSchema: {
        title: z.string().min(1),
        goal: z.string().min(1),
        actor: z.string().optional(),
        priority: z.string().optional(),
        deps: z.array(z.string()).optional(),
        parent: z.string().optional(),
        project: z.string().optional(),
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
          project: args.project,
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
    'workgraph_thread_claim',
    {
      title: 'Thread Claim',
      description: 'Claim an open thread for an actor.',
      inputSchema: {
        threadPath: z.string().min(1),
        actor: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => mutateThread(options, args.actor, ['thread:claim', 'mcp:write'], args.threadPath, () =>
      thread.claim(options.workspacePath, args.threadPath, resolveActor(options.workspacePath, args.actor, options.defaultActor)),
      'Claimed thread',
    ),
  );

  server.registerTool(
    'workgraph_thread_release',
    {
      title: 'Thread Release',
      description: 'Release an active thread back to open.',
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
    async (args) => mutateThread(options, args.actor, ['thread:update', 'mcp:write'], args.threadPath, () =>
      thread.release(options.workspacePath, args.threadPath, resolveActor(options.workspacePath, args.actor, options.defaultActor), args.reason),
      'Released thread',
    ),
  );

  server.registerTool(
    'workgraph_thread_heartbeat',
    {
      title: 'Thread Heartbeat',
      description: 'Refresh the heartbeat on a claimed thread.',
      inputSchema: {
        threadPath: z.string().min(1),
        actor: z.string().optional(),
        leaseMinutes: z.number().int().min(1).max(240).optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => mutateThread(options, args.actor, ['thread:update', 'mcp:write'], args.threadPath, () =>
      thread.heartbeat(
        options.workspacePath,
        args.threadPath,
        resolveActor(options.workspacePath, args.actor, options.defaultActor),
        args.leaseMinutes,
      ),
      'Heartbeated thread',
    ),
  );

  server.registerTool(
    'workgraph_thread_join',
    {
      title: 'Thread Join',
      description: 'Join a thread as a participant.',
      inputSchema: {
        threadPath: z.string().min(1),
        actor: z.string().optional(),
        role: z.enum(['contributor', 'reviewer', 'observer']).optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => mutateThread(options, args.actor, ['thread:update', 'mcp:write'], args.threadPath, () =>
      thread.joinThread(
        options.workspacePath,
        args.threadPath,
        resolveActor(options.workspacePath, args.actor, options.defaultActor),
        args.role,
      ),
      'Joined thread',
    ),
  );

  server.registerTool(
    'workgraph_thread_handoff',
    {
      title: 'Thread Handoff',
      description: 'Hand off a claimed thread to another actor.',
      inputSchema: {
        threadPath: z.string().min(1),
        actor: z.string().optional(),
        toActor: z.string().min(1),
        reason: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => mutateThread(options, args.actor, ['thread:update', 'mcp:write'], args.threadPath, () =>
      thread.handoff(
        options.workspacePath,
        args.threadPath,
        resolveActor(options.workspacePath, args.actor, options.defaultActor),
        args.toActor,
        args.reason,
      ),
      'Handed off thread',
    ),
  );

  server.registerTool(
    'workgraph_thread_block',
    {
      title: 'Thread Block',
      description: 'Block an active thread on a dependency or reason.',
      inputSchema: {
        threadPath: z.string().min(1),
        actor: z.string().optional(),
        blockedBy: z.string().optional(),
        reason: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => mutateThread(options, args.actor, ['thread:update', 'mcp:write'], args.threadPath, () =>
      thread.block(
        options.workspacePath,
        args.threadPath,
        resolveActor(options.workspacePath, args.actor, options.defaultActor),
        args.blockedBy ?? 'external/manual',
        args.reason,
      ),
      'Blocked thread',
    ),
  );

  server.registerTool(
    'workgraph_thread_unblock',
    {
      title: 'Thread Unblock',
      description: 'Unblock a blocked thread.',
      inputSchema: {
        threadPath: z.string().min(1),
        actor: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => mutateThread(options, args.actor, ['thread:update', 'mcp:write'], args.threadPath, () =>
      thread.unblock(options.workspacePath, args.threadPath, resolveActor(options.workspacePath, args.actor, options.defaultActor)),
      'Unblocked thread',
    ),
  );

  server.registerTool(
    'workgraph_thread_done',
    {
      title: 'Thread Done',
      description: 'Complete a claimed thread with optional evidence and output.',
      inputSchema: {
        threadPath: z.string().min(1),
        actor: z.string().optional(),
        output: z.string().optional(),
        evidence: z.array(z.string()).optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => mutateThread(options, args.actor, ['thread:complete', 'mcp:write'], args.threadPath, () =>
      thread.done(
        options.workspacePath,
        args.threadPath,
        resolveActor(options.workspacePath, args.actor, options.defaultActor),
        args.output,
        { evidence: args.evidence },
      ),
      'Completed thread',
    ),
  );

  server.registerTool(
    'workgraph_thread_update_status',
    {
      title: 'Thread Update Status',
      description: 'Update thread lifecycle status through one canonical tool.',
      inputSchema: {
        threadPath: z.string().min(1),
        actor: z.string().optional(),
        status: threadStatusSchema,
        reason: z.string().optional(),
        output: z.string().optional(),
        blockedBy: z.string().optional(),
        leaseMinutes: z.number().int().min(1).max(240).optional(),
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
          action: 'mcp.thread.update-status',
          target: args.threadPath,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const updated = updateThreadStatus(options.workspacePath, args, actor);
        return okResult({ thread: updated }, `Updated thread ${updated.path} to ${String(updated.fields.status)}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_checkpoint_create',
    {
      title: 'Checkpoint Create',
      description: 'Create a checkpoint for actor handoff continuity.',
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
        const gate = checkWriteGate(options, actor, ['thread:update', 'mcp:write'], {
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
    'workgraph_primitive_define',
    {
      title: 'Primitive Define',
      description: 'Define a new primitive type for the context graph registry.',
      inputSchema: {
        actor: z.string().optional(),
        name: z.string().min(1),
        description: z.string().min(1),
        directory: z.string().optional(),
        fields: z.record(z.string(), z.object({
          type: z.enum(['string', 'number', 'boolean', 'list', 'date', 'ref', 'any']),
          required: z.boolean().optional(),
          default: z.unknown().optional(),
          description: z.string().optional(),
          enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
          template: z.enum(['slug', 'semver', 'email', 'url', 'iso-date']).optional(),
          pattern: z.string().optional(),
          refTypes: z.array(z.string()).optional(),
        })),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['policy:manage', 'mcp:write'], {
          action: 'mcp.primitive.define',
          target: '.workgraph/registry.json',
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const defined = registry.defineType(
          options.workspacePath,
          args.name,
          args.description,
          args.fields,
          actor,
          args.directory,
        );
        return okResult({ type: defined }, `Defined primitive type ${defined.name}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

async function mutateThread(
  options: WorkgraphMcpServerOptions,
  actorInput: string | undefined,
  requiredCapabilities: string[],
  threadPath: string,
  action: () => ReturnType<typeof thread.createThread> | Promise<ReturnType<typeof thread.createThread>>,
  summaryPrefix: string,
) {
  try {
    const actor = resolveActor(options.workspacePath, actorInput, options.defaultActor);
    const gate = checkWriteGate(options, actor, requiredCapabilities, {
      action: `mcp.thread.${summaryPrefix.toLowerCase().replace(/\s+/g, '-')}`,
      target: threadPath,
    });
    if (!gate.allowed) return errorResult(gate.reason);
    const updated = await action();
    return okResult({ thread: updated }, `${summaryPrefix} ${updated.path}.`);
  } catch (error) {
    return errorResult(error);
  }
}

function updateThreadStatus(
  workspacePath: string,
  args: {
    threadPath: string;
    status: z.infer<typeof threadStatusSchema>;
    reason?: string;
    output?: string;
    blockedBy?: string;
    leaseMinutes?: number;
  },
  actor: string,
) {
  switch (args.status) {
    case 'open':
      return thread.release(workspacePath, args.threadPath, actor, args.reason);
    case 'active':
      return thread.claim(workspacePath, args.threadPath, actor, {
        leaseTtlMinutes: args.leaseMinutes,
      });
    case 'blocked':
      return thread.block(workspacePath, args.threadPath, actor, args.blockedBy ?? 'external/manual', args.reason);
    case 'done':
      return thread.done(workspacePath, args.threadPath, actor, args.output);
    case 'cancelled':
      return thread.cancel(workspacePath, args.threadPath, actor, args.reason);
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
