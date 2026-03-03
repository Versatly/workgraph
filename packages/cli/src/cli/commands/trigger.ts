import { Command } from 'commander';
import * as workgraph from '../../../../kernel/src/index.js';
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
      .option('--json', 'Emit structured JSON output'),
  ).action((triggerPath, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.trigger.fireTrigger(workspacePath, triggerPath, {
          actor: opts.actor,
          eventKey: opts.eventKey,
          objective: opts.objective,
        });
      },
      (result) => [
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
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.triggerEngine.runTriggerEngineCycle(workspacePath, {
          actor: opts.actor,
        });
      },
      (result) => [
        `Evaluated: ${result.evaluated} triggers`,
        `Fired: ${result.fired}`,
        `Errors: ${result.errors}`,
        ...result.triggers.map((t) =>
          `  ${t.triggerPath}: ${t.fired ? 'FIRED' : 'skipped'} (${t.reason})${t.error ? ` error: ${t.error}` : ''}`,
        ),
      ],
    ),
  );
}
