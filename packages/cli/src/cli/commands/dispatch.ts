import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import {
  addWorkspaceOption,
  csv,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

export function registerDispatchCommands(program: Command, defaultActor: string): void {
  const dispatchCmd = program
    .command('dispatch')
    .description('Programmatic runtime dispatch contract');

  addWorkspaceOption(
    dispatchCmd
      .command('create <objective>')
      .description('Create a new run dispatch request')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--adapter <name>', 'Adapter name', 'cursor-cloud')
      .option('--idempotency-key <key>', 'Idempotency key')
      .option('--json', 'Emit structured JSON output'),
  ).action((objective, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          run: workgraph.dispatch.createRun(workspacePath, {
            actor: opts.actor,
            adapter: opts.adapter,
            objective,
            idempotencyKey: opts.idempotencyKey,
          }),
        };
      },
      (result) => [`Run created: ${result.run.id} [${result.run.status}]`],
    ),
  );

  addWorkspaceOption(
    dispatchCmd
      .command('claim <threadRef>')
      .description('Claim a thread after passing quality gates')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((threadRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.dispatch.claimThread(workspacePath, threadRef, opts.actor);
      },
      (result) => [
        `Claimed thread: ${result.thread.path}`,
        `Gates checked: ${result.gateCheck.gates.length}`,
      ],
    ),
  );

  addWorkspaceOption(
    dispatchCmd
      .command('create-execute <objective>')
      .description('Create and execute a run with autonomous multi-agent coordination')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--adapter <name>', 'Adapter name', 'cursor-cloud')
      .option('--idempotency-key <key>', 'Idempotency key')
      .option('--agents <actors>', 'Comma-separated agent identities for autonomous execution')
      .option('--max-steps <n>', 'Maximum scheduler steps', '200')
      .option('--step-delay-ms <ms>', 'Delay between scheduling steps', '25')
      .option('--space <spaceRef>', 'Restrict execution to one space')
      .option('--no-checkpoint', 'Skip automatic checkpoint generation after execution')
      .option('--json', 'Emit structured JSON output'),
  ).action((objective, opts) =>
    runCommand(
      opts,
      async () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          run: await workgraph.dispatch.createAndExecuteRun(
            workspacePath,
            {
              actor: opts.actor,
              adapter: opts.adapter,
              objective,
              idempotencyKey: opts.idempotencyKey,
            },
            {
              agents: csv(opts.agents),
              maxSteps: Number.parseInt(String(opts.maxSteps), 10),
              stepDelayMs: Number.parseInt(String(opts.stepDelayMs), 10),
              space: opts.space,
              createCheckpoint: opts.checkpoint,
            },
          ),
        };
      },
      (result) => [
        `Run executed: ${result.run.id} [${result.run.status}]`,
        ...(result.run.output ? [`Output: ${result.run.output}`] : []),
        ...(result.run.error ? [`Error: ${result.run.error}`] : []),
      ],
    ),
  );

  addWorkspaceOption(
    dispatchCmd
      .command('list')
      .description('List runs')
      .option('--status <status>', 'queued|running|succeeded|failed|cancelled')
      .option('--limit <n>', 'Result limit')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          runs: workgraph.dispatch.listRuns(workspacePath, {
            status: opts.status,
            limit: opts.limit ? Number.parseInt(String(opts.limit), 10) : undefined,
          }),
        };
      },
      (result) => result.runs.map((run) => `${run.id} [${run.status}] ${run.objective}`),
    ),
  );

  addWorkspaceOption(
    dispatchCmd
      .command('status <runId>')
      .description('Get run status by ID')
      .option('--json', 'Emit structured JSON output'),
  ).action((runId, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          run: workgraph.dispatch.status(workspacePath, runId),
        };
      },
      (result) => [`${result.run.id} [${result.run.status}]`],
    ),
  );

  addWorkspaceOption(
    dispatchCmd
      .command('execute <runId>')
      .description('Execute a queued/running run via adapter autonomous scheduling')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--agents <actors>', 'Comma-separated agent identities')
      .option('--max-steps <n>', 'Maximum scheduler steps', '200')
      .option('--step-delay-ms <ms>', 'Delay between scheduling steps', '25')
      .option('--space <spaceRef>', 'Restrict execution to one space')
      .option('--no-checkpoint', 'Skip automatic checkpoint generation after execution')
      .option('--json', 'Emit structured JSON output'),
  ).action((runId, opts) =>
    runCommand(
      opts,
      async () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          run: await workgraph.dispatch.executeRun(workspacePath, runId, {
            actor: opts.actor,
            agents: csv(opts.agents),
            maxSteps: Number.parseInt(String(opts.maxSteps), 10),
            stepDelayMs: Number.parseInt(String(opts.stepDelayMs), 10),
            space: opts.space,
            createCheckpoint: opts.checkpoint,
          }),
        };
      },
      (result) => [
        `Run executed: ${result.run.id} [${result.run.status}]`,
        ...(result.run.output ? [`Output: ${result.run.output}`] : []),
        ...(result.run.error ? [`Error: ${result.run.error}`] : []),
      ],
    ),
  );

  addWorkspaceOption(
    dispatchCmd
      .command('followup <runId> <input>')
      .description('Send follow-up input to a run')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((runId, input, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          run: workgraph.dispatch.followup(workspacePath, runId, opts.actor, input),
        };
      },
      (result) => [`Follow-up recorded: ${result.run.id} [${result.run.status}]`],
    ),
  );

  addWorkspaceOption(
    dispatchCmd
      .command('stop <runId>')
      .description('Cancel a run')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((runId, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          run: workgraph.dispatch.stop(workspacePath, runId, opts.actor),
        };
      },
      (result) => [`Stopped run: ${result.run.id} [${result.run.status}]`],
    ),
  );

  addWorkspaceOption(
    dispatchCmd
      .command('heartbeat <runId>')
      .description('Heartbeat a running run lease and extend lease_expiry')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--lease-minutes <n>', 'Lease extension in minutes')
      .option('--json', 'Emit structured JSON output'),
  ).action((runId, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          run: workgraph.dispatch.heartbeat(workspacePath, runId, {
            actor: opts.actor,
            leaseMinutes: opts.leaseMinutes ? Number.parseInt(String(opts.leaseMinutes), 10) : undefined,
          }),
        };
      },
      (result) => [
        `Heartbeated run: ${result.run.id}`,
        `Lease expires: ${String(result.run.leaseExpires ?? 'none')}`,
        `Heartbeats: ${(result.run.heartbeats ?? []).length}`,
      ],
    ),
  );

  addWorkspaceOption(
    dispatchCmd
      .command('reconcile')
      .description('Requeue runs with expired leases')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.dispatch.reconcileExpiredLeases(workspacePath, opts.actor);
      },
      (result) => [
        `Reconciled at: ${result.reconciledAt}`,
        `Inspected runs: ${result.inspectedRuns}`,
        `Requeued runs: ${result.requeuedRuns.length}`,
        ...result.requeuedRuns.map((run) => `- ${run.id}`),
      ],
    ),
  );

  addWorkspaceOption(
    dispatchCmd
      .command('handoff <runId>')
      .description('Create a structured run handoff to another agent')
      .requiredOption('--to <agent>', 'Target agent')
      .requiredOption('--reason <text>', 'Reason for handoff')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--adapter <name>', 'Adapter override for handoff run')
      .option('--json', 'Emit structured JSON output'),
  ).action((runId, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.dispatch.handoffRun(workspacePath, runId, {
          actor: opts.actor,
          to: opts.to,
          reason: opts.reason,
          adapter: opts.adapter,
        });
      },
      (result) => [
        `Handoff created: ${result.handoffRun.id} (from ${result.sourceRun.id})`,
        `Target agent: ${result.handoffRun.actor}`,
        `Objective: ${result.handoffRun.objective}`,
      ],
    ),
  );

  addWorkspaceOption(
    dispatchCmd
      .command('mark <runId>')
      .description('Set run status transition explicitly')
      .requiredOption('--status <status>', 'running|succeeded|failed|cancelled')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--output <text>', 'Optional output payload')
      .option('--error <text>', 'Optional error payload')
      .option('--json', 'Emit structured JSON output'),
  ).action((runId, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const status = normalizeRunStatus(opts.status);
        return {
          run: workgraph.dispatch.markRun(workspacePath, runId, opts.actor, status, {
            output: opts.output,
            error: opts.error,
          }),
        };
      },
      (result) => [`Marked run: ${result.run.id} [${result.run.status}]`],
    ),
  );

  addWorkspaceOption(
    dispatchCmd
      .command('logs <runId>')
      .description('Read logs from a run')
      .option('--json', 'Emit structured JSON output'),
  ).action((runId, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          runId,
          logs: workgraph.dispatch.logs(workspacePath, runId),
        };
      },
      (result) => result.logs.map((entry) => `${entry.ts} [${entry.level}] ${entry.message}`),
    ),
  );
}

function normalizeRunStatus(status: string): 'running' | 'succeeded' | 'failed' | 'cancelled' {
  const normalized = String(status).toLowerCase();
  if (normalized === 'running' || normalized === 'succeeded' || normalized === 'failed' || normalized === 'cancelled') {
    return normalized;
  }
  throw new Error(`Invalid run status "${status}". Expected running|succeeded|failed|cancelled.`);
}
