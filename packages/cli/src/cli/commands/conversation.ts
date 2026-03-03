import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import {
  addWorkspaceOption,
  csv,
  parsePositiveIntegerOption,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

export function registerConversationCommands(program: Command, defaultActor: string): void {
  const conversationCmd = program
    .command('conversation')
    .description('Coordinate multi-thread conversations and stateful planning');

  addWorkspaceOption(
    conversationCmd
      .command('create <title>')
      .description('Create a conversation spanning one or more threads')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--threads <refs>', 'Comma-separated thread refs')
      .option('--tags <tags>', 'Comma-separated tags')
      .option('--status <status>', 'open|active|blocked|done|cancelled', 'open')
      .option('--json', 'Emit structured JSON output'),
  ).action((title, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.conversation.createConversation(workspacePath, title, opts.actor, {
          threadRefs: csv(opts.threads),
          tags: csv(opts.tags),
          status: normalizeConversationStatus(opts.status),
        });
      },
      (result) => [
        `Created conversation: ${result.conversation.path}`,
        `Status: ${result.summary.status}`,
        `Threads: ${result.summary.threadRefs.length}`,
      ],
    ),
  );

  addWorkspaceOption(
    conversationCmd
      .command('list')
      .description('List conversation primitives with derived state')
      .option('--status <status>', 'open|active|blocked|done|cancelled')
      .option('--thread <ref>', 'Filter by attached thread ref')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          conversations: workgraph.conversation.listConversations(workspacePath, {
            status: opts.status ? normalizeConversationStatus(opts.status) : undefined,
            threadRef: opts.thread,
          }),
        };
      },
      (result) => {
        if (result.conversations.length === 0) return ['No conversations found.'];
        return result.conversations.map((entry) =>
          `[${entry.summary.status}] progress=${entry.summary.progress}% threads=${entry.summary.threadRefs.length} steps=${entry.summary.steps.total} ${entry.conversation.path}`);
      },
    ),
  );

  addWorkspaceOption(
    conversationCmd
      .command('show <conversationRef>')
      .description('Show conversation details and derived state summary')
      .option('--json', 'Emit structured JSON output'),
  ).action((conversationRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.conversation.getConversation(workspacePath, conversationRef);
      },
      (result) => [
        `Conversation: ${result.conversation.path}`,
        `Status: ${result.summary.status} Progress: ${result.summary.progress}%`,
        `Threads: ${result.summary.threadRefs.join(', ') || 'none'}`,
        `Plan steps: total=${result.summary.steps.total} done=${result.summary.steps.done} blocked=${result.summary.steps.blocked}`,
        `Messages: ${result.summary.messageCount}`,
      ],
    ),
  );

  addWorkspaceOption(
    conversationCmd
      .command('message <conversationRef> <text>')
      .description('Append a conversation timeline event/message')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--kind <kind>', 'message|note|decision|system', 'message')
      .option('--thread <ref>', 'Optional thread ref associated to this message')
      .option('--json', 'Emit structured JSON output'),
  ).action((conversationRef, text, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.conversation.appendConversationMessage(
          workspacePath,
          conversationRef,
          opts.actor,
          text,
          {
            kind: normalizeConversationEventKind(opts.kind),
            threadRef: opts.thread,
          },
        );
      },
      (result) => [
        `Updated conversation: ${result.conversation.path}`,
        `Status: ${result.summary.status}`,
        `Messages: ${result.summary.messageCount}`,
      ],
    ),
  );

  addWorkspaceOption(
    conversationCmd
      .command('state <conversationRef>')
      .description('Compute conversation state/progress summary')
      .option('--json', 'Emit structured JSON output'),
  ).action((conversationRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          summary: workgraph.conversation.summarizeConversationState(workspacePath, conversationRef),
        };
      },
      (result) => [
        `Conversation: ${result.summary.conversationPath}`,
        `Status: ${result.summary.status}`,
        `Progress: ${result.summary.progress}%`,
        `Steps: total=${result.summary.steps.total} open=${result.summary.steps.open} active=${result.summary.steps.active} blocked=${result.summary.steps.blocked} done=${result.summary.steps.done} cancelled=${result.summary.steps.cancelled}`,
        `Threads: total=${result.summary.threads.total} missing=${result.summary.threads.missing}`,
        `Messages: ${result.summary.messageCount}`,
      ],
    ),
  );

  addWorkspaceOption(
    conversationCmd
      .command('thread-add <conversationRef> <threadRef>')
      .description('Attach a thread to a conversation')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((conversationRef, threadRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.conversation.attachConversationThread(workspacePath, conversationRef, threadRef, opts.actor);
      },
      (result) => [
        `Conversation: ${result.conversation.path}`,
        `Threads: ${result.summary.threadRefs.join(', ') || 'none'}`,
      ],
    ),
  );

  addWorkspaceOption(
    conversationCmd
      .command('thread-remove <conversationRef> <threadRef>')
      .description('Detach a thread from a conversation')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((conversationRef, threadRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.conversation.detachConversationThread(workspacePath, conversationRef, threadRef, opts.actor);
      },
      (result) => [
        `Conversation: ${result.conversation.path}`,
        `Threads: ${result.summary.threadRefs.join(', ') || 'none'}`,
      ],
    ),
  );

  const planStepCmd = program
    .command('plan-step')
    .description('Manage execution steps linked to conversations and threads');

  addWorkspaceOption(
    planStepCmd
      .command('create <conversationRef> <title>')
      .description('Create a plan-step for a conversation')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--thread <threadRef>', 'Associated thread ref')
      .option('--assignee <name>', 'Assignee')
      .option('--order <n>', 'Execution order (positive integer)')
      .option('--status <status>', 'open|active|blocked|done|cancelled', 'open')
      .option('--tags <tags>', 'Comma-separated tags')
      .option('--body <markdown>', 'Override markdown body')
      .option('--json', 'Emit structured JSON output'),
  ).action((conversationRef, title, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          step: workgraph.conversation.createPlanStep(workspacePath, title, opts.actor, {
            conversationRef,
            threadRef: opts.thread,
            assignee: opts.assignee,
            order: opts.order ? parsePositiveIntegerOption(opts.order, 'order') : undefined,
            status: normalizePlanStepStatus(opts.status),
            tags: csv(opts.tags),
            body: opts.body,
          }),
        };
      },
      (result) => [
        `Created plan-step: ${result.step.path}`,
        `Status: ${String(result.step.fields.status)} Progress: ${String(result.step.fields.progress)}%`,
      ],
    ),
  );

  addWorkspaceOption(
    planStepCmd
      .command('list')
      .description('List plan-steps with optional conversation/thread/status filters')
      .option('--conversation <conversationRef>', 'Filter by conversation ref')
      .option('--thread <threadRef>', 'Filter by thread ref')
      .option('--status <status>', 'open|active|blocked|done|cancelled')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const status = opts.status ? normalizePlanStepStatus(opts.status) : undefined;
        const steps = workgraph.conversation.listPlanSteps(workspacePath, {
          conversationRef: opts.conversation,
          threadRef: opts.thread,
          status,
        });
        return { steps, count: steps.length };
      },
      (result) => {
        if (result.steps.length === 0) return ['No plan-steps found.'];
        return [
          ...result.steps.map((step) =>
            `[${String(step.fields.status)}] ${String(step.fields.progress)}% ${String(step.fields.title)} -> ${step.path}`),
          `${result.count} plan-step(s)`,
        ];
      },
    ),
  );

  addWorkspaceOption(
    planStepCmd
      .command('start <planStepRef>')
      .description('Transition a plan-step to active execution')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((planStepRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          step: workgraph.conversation.updatePlanStepStatus(workspacePath, planStepRef, 'active', opts.actor),
        };
      },
      (result) => [`Started plan-step: ${result.step.path}`],
    ),
  );

  addWorkspaceOption(
    planStepCmd
      .command('progress <planStepRef> <value>')
      .description('Update plan-step progress percentage (0..100)')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((planStepRef, value, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          step: workgraph.conversation.updatePlanStepProgress(workspacePath, planStepRef, Number(value), opts.actor),
        };
      },
      (result) => [`Progress updated: ${result.step.path} ${String(result.step.fields.progress)}%`],
    ),
  );

  addWorkspaceOption(
    planStepCmd
      .command('block <planStepRef>')
      .description('Mark a plan-step blocked with a reason')
      .requiredOption('--reason <text>', 'Blocking reason')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((planStepRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          step: workgraph.conversation.updatePlanStepStatus(workspacePath, planStepRef, 'blocked', opts.actor, {
            reason: opts.reason,
          }),
        };
      },
      (result) => [`Blocked plan-step: ${result.step.path}`],
    ),
  );

  addWorkspaceOption(
    planStepCmd
      .command('done <planStepRef>')
      .description('Mark a plan-step done')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((planStepRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          step: workgraph.conversation.updatePlanStepStatus(workspacePath, planStepRef, 'done', opts.actor),
        };
      },
      (result) => [`Completed plan-step: ${result.step.path}`],
    ),
  );

  addWorkspaceOption(
    planStepCmd
      .command('cancel <planStepRef>')
      .description('Cancel a plan-step with optional reason')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--reason <text>', 'Cancellation reason')
      .option('--json', 'Emit structured JSON output'),
  ).action((planStepRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          step: workgraph.conversation.updatePlanStepStatus(workspacePath, planStepRef, 'cancelled', opts.actor, {
            reason: opts.reason,
          }),
        };
      },
      (result) => [`Cancelled plan-step: ${result.step.path}`],
    ),
  );
}

function normalizeConversationStatus(status: string): 'open' | 'active' | 'blocked' | 'done' | 'cancelled' {
  const normalized = String(status).toLowerCase();
  if (normalized === 'open' || normalized === 'active' || normalized === 'blocked' || normalized === 'done' || normalized === 'cancelled') {
    return normalized;
  }
  throw new Error(`Invalid conversation status "${status}". Expected open|active|blocked|done|cancelled.`);
}

function normalizePlanStepStatus(status: string): 'open' | 'active' | 'blocked' | 'done' | 'cancelled' {
  const normalized = String(status).toLowerCase();
  if (normalized === 'open' || normalized === 'active' || normalized === 'blocked' || normalized === 'done' || normalized === 'cancelled') {
    return normalized;
  }
  throw new Error(`Invalid plan-step status "${status}". Expected open|active|blocked|done|cancelled.`);
}

function normalizeConversationEventKind(kind: string): 'message' | 'note' | 'decision' | 'system' {
  const normalized = String(kind).toLowerCase();
  if (normalized === 'message' || normalized === 'note' || normalized === 'decision' || normalized === 'system') {
    return normalized;
  }
  throw new Error(`Invalid conversation message kind "${kind}". Expected message|note|decision|system.`);
}
