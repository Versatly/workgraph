import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as autonomy from '../../autonomy.js';
import * as dispatch from '../../dispatch.js';
import * as orientation from '../../orientation.js';
import * as thread from '../../thread.js';
import * as triggerEngine from '../../trigger-engine.js';
import { checkWriteGate, resolveActor } from '../auth.js';
import { errorResult, okResult } from '../result.js';
import type { WorkgraphMcpServerOptions } from '../types.js';

export function registerWriteTools(server: McpServer, options: WorkgraphMcpServerOptions): void {
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
        evidence: z.array(z.string()).optional(),
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
        const updated = thread.done(options.workspacePath, args.threadPath, actor, args.output, {
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
        const actor = resolveActor(args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['dispatch:run', 'mcp:write']);
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
        const actor = resolveActor(args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['dispatch:run', 'mcp:write']);
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
}
