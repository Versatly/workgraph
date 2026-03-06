import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import {
  addWorkspaceOption,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

export function registerAdapterCommands(program: Command, defaultActor: string): void {
  const adapterCmd = program
    .command('adapter')
    .description('Inspect and exercise dispatch adapter integrations');

  addWorkspaceOption(
    adapterCmd
      .command('list')
      .description('List available runtime dispatch adapters')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const adapters = workgraph.runtimeAdapterRegistry.listDispatchAdapters();
        return {
          adapters,
          count: adapters.length,
        };
      },
      (result) => {
        if (result.adapters.length === 0) return ['No dispatch adapters registered.'];
        return [
          ...result.adapters.map((name) => name),
          `${result.count} adapter(s)`,
        ];
      },
    ),
  );

  addWorkspaceOption(
    adapterCmd
      .command('test <adapter>')
      .description('Run contract smoke test against one adapter')
      .option('-a, --actor <name>', 'Actor identity', defaultActor)
      .option('--objective <text>', 'Objective text for create/execute probes', 'Adapter smoke test')
      .option('--context <json>', 'JSON object passed as adapter context')
      .option('--execute', 'Invoke execute() after lifecycle checks')
      .option('--json', 'Emit structured JSON output'),
  ).action((adapterName, opts) =>
    runCommand(
      opts,
      async () => {
        const knownAdapters = workgraph.runtimeAdapterRegistry.listDispatchAdapters();
        let adapter: workgraph.DispatchAdapter;
        try {
          adapter = workgraph.runtimeAdapterRegistry.resolveDispatchAdapter(adapterName);
        } catch {
          throw new Error(`Unknown adapter "${adapterName}". Registered adapters: ${knownAdapters.join(', ') || 'none'}.`);
        }

        const context = parseContextOption(opts.context);
        const created = await adapter.create({
          actor: opts.actor,
          objective: opts.objective,
          ...(context ? { context } : {}),
        });
        const status = await adapter.status(created.runId);
        const followup = await adapter.followup(created.runId, opts.actor, 'adapter smoke follow-up');
        const logs = await adapter.logs(created.runId);
        const stopped = await adapter.stop(created.runId, opts.actor);

        const execution = opts.execute
          ? await runExecuteProbe(adapterName, adapter, {
            workspacePath: resolveWorkspacePath(opts),
            runId: created.runId,
            actor: opts.actor,
            objective: opts.objective,
            ...(context ? { context } : {}),
          })
          : undefined;

        return {
          adapter: adapter.name,
          created,
          status,
          followup,
          stopped,
          logsCount: logs.length,
          ...(execution ? { execution } : {}),
        };
      },
      (result) => [
        `Adapter: ${result.adapter}`,
        `Create: ${result.created.status} (${result.created.runId})`,
        `Status: ${result.status.status}`,
        `Follow-up: ${result.followup.status}`,
        `Stop: ${result.stopped.status}`,
        `Logs read: ${result.logsCount}`,
        ...(result.execution
          ? [
            `Execute: ${result.execution.status}`,
            ...(result.execution.output ? [`Execute output: ${result.execution.output}`] : []),
            ...(result.execution.error ? [`Execute error: ${result.execution.error}`] : []),
          ]
          : []),
      ],
    ),
  );
}

async function runExecuteProbe(
  adapterName: string,
  adapter: workgraph.DispatchAdapter,
  input: {
    workspacePath: string;
    runId: string;
    actor: string;
    objective: string;
    context?: Record<string, unknown>;
  },
) {
  if (!adapter.execute) {
    throw new Error(`Adapter "${adapterName}" does not implement execute(). Remove --execute or choose another adapter.`);
  }
  return adapter.execute(input);
}

function parseContextOption(rawValue: unknown): Record<string, unknown> | undefined {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim().length === 0) {
    return undefined;
  }
  const parsed = JSON.parse(String(rawValue)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid --context value. Expected a JSON object.');
  }
  return parsed as Record<string, unknown>;
}
