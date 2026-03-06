import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import {
  addWorkspaceOption,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

export function registerTriggerCommands(program: Command, defaultActor: string): void {
  const triggerCmd = program
    .command('trigger')
    .description('Trigger primitives and run dispatch lifecycle');

  addWorkspaceOption(
    triggerCmd
      .command('fire <triggerPath>')
      .description('Fire an approved/active trigger and dispatch a run')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--event-key <key>', 'Deterministic event key for idempotency')
      .option('--objective <text>', 'Override run objective')
      .option('--adapter <name>', 'Adapter override for dispatched run')
      .option('--execute', 'Execute the triggered run immediately')
      .option('--retry-failed', 'Retry failed run when idempotency resolves to failed status')
      .option('--agents <actors>', 'Comma-separated agent identities for execution')
      .option('--max-steps <n>', 'Maximum scheduler steps for execution')
      .option('--step-delay-ms <ms>', 'Delay between scheduling steps for execution')
      .option('--space <spaceRef>', 'Restrict execution to one space')
      .option('--timeout-ms <ms>', 'Execution timeout in milliseconds')
      .option('--dispatch-mode <mode>', 'direct|self-assembly')
      .option('--self-assembly-agent <agent>', 'Agent identity for self-assembly dispatch mode')
      .option('--json', 'Emit structured JSON output'),
  ).action((triggerPath, opts) =>
    runCommand(
      opts,
      async () => {
        const workspacePath = resolveWorkspacePath(opts);
        if (opts.execute) {
          return workgraph.trigger.fireTriggerAndExecute(workspacePath, triggerPath, {
            actor: opts.actor,
            eventKey: opts.eventKey,
            objective: opts.objective,
            adapter: opts.adapter,
            retryFailed: Boolean(opts.retryFailed),
            executeInput: {
              agents: opts.agents ? String(opts.agents).split(',').map((entry: string) => entry.trim()).filter(Boolean) : undefined,
              maxSteps: opts.maxSteps ? Number.parseInt(String(opts.maxSteps), 10) : undefined,
              stepDelayMs: opts.stepDelayMs ? Number.parseInt(String(opts.stepDelayMs), 10) : undefined,
              space: opts.space,
              timeoutMs: opts.timeoutMs ? Number.parseInt(String(opts.timeoutMs), 10) : undefined,
              dispatchMode: opts.dispatchMode,
              selfAssemblyAgent: opts.selfAssemblyAgent,
            },
          });
        }
        return workgraph.trigger.fireTrigger(workspacePath, triggerPath, {
          actor: opts.actor,
          eventKey: opts.eventKey,
          objective: opts.objective,
          adapter: opts.adapter,
        });
      },
      (result) => [
        ...(() => {
          const executedResult = result as { executed?: boolean; retriedFromRunId?: string };
          if (!executedResult.executed) return [];
          return [`Executed: yes${executedResult.retriedFromRunId ? ` (retried from ${executedResult.retriedFromRunId})` : ''}`];
        })(),
        `Fired trigger: ${result.triggerPath}`,
        `Run: ${result.run.id} [${result.run.status}]`,
      ],
    ),
  );

  const triggerEngineCmd = triggerCmd
    .command('engine')
    .description('Run trigger engine');

  addWorkspaceOption(
    triggerEngineCmd
      .command('run')
      .description('Process one trigger-engine cycle')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--execute-runs', 'Execute dispatch-run actions as full run->evidence loop')
      .option('--retry-failed-runs', 'Retry failed runs when dispatch-run hits failed idempotent runs')
      .option('--agents <actors>', 'Comma-separated agent identities for execution')
      .option('--max-steps <n>', 'Maximum scheduler steps for execution')
      .option('--step-delay-ms <ms>', 'Delay between scheduling steps for execution')
      .option('--space <spaceRef>', 'Restrict execution to one space')
      .option('--timeout-ms <ms>', 'Execution timeout in milliseconds')
      .option('--dispatch-mode <mode>', 'direct|self-assembly')
      .option('--self-assembly-agent <agent>', 'Agent identity for self-assembly dispatch mode')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      async () => {
        const workspacePath = resolveWorkspacePath(opts);
        if (opts.executeRuns) {
          return workgraph.triggerEngine.runTriggerRunEvidenceLoop(workspacePath, {
            actor: opts.actor,
            retryFailedRuns: Boolean(opts.retryFailedRuns),
            execution: {
              agents: opts.agents ? String(opts.agents).split(',').map((entry: string) => entry.trim()).filter(Boolean) : undefined,
              maxSteps: opts.maxSteps ? Number.parseInt(String(opts.maxSteps), 10) : undefined,
              stepDelayMs: opts.stepDelayMs ? Number.parseInt(String(opts.stepDelayMs), 10) : undefined,
              space: opts.space,
              timeoutMs: opts.timeoutMs ? Number.parseInt(String(opts.timeoutMs), 10) : undefined,
              dispatchMode: opts.dispatchMode,
              selfAssemblyAgent: opts.selfAssemblyAgent,
            },
          });
        }
        return workgraph.triggerEngine.runTriggerEngineCycle(workspacePath, {
          actor: opts.actor,
        });
      },
      (result) => {
        if ('cycle' in result) {
          return [
            `Evaluated: ${result.cycle.evaluated} triggers`,
            `Fired: ${result.cycle.fired}`,
            `Errors: ${result.cycle.errors}`,
            `Executed runs: ${result.executedRuns.length} (succeeded=${result.succeeded}, failed=${result.failed}, cancelled=${result.cancelled}, skipped=${result.skipped})`,
            ...result.cycle.triggers.map((t) =>
              `  ${t.triggerPath}: ${t.fired ? 'FIRED' : 'skipped'} (${t.reason})${t.error ? ` error: ${t.error}` : ''}`,
            ),
            ...result.executedRuns.map((run) =>
              `  run ${run.runId}: ${run.status}${run.retriedFromRunId ? ` (retried from ${run.retriedFromRunId})` : ''}${run.error ? ` error: ${run.error}` : ''}`,
            ),
          ];
        }
        return [
          `Evaluated: ${result.evaluated} triggers`,
          `Fired: ${result.fired}`,
          `Errors: ${result.errors}`,
          ...result.triggers.map((t) =>
            `  ${t.triggerPath}: ${t.fired ? 'FIRED' : 'skipped'} (${t.reason})${t.error ? ` error: ${t.error}` : ''}`,
          ),
        ];
      },
    ),
  );
}
