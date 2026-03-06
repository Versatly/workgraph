import { Command } from 'commander';
import {
  createDefaultRuntimeAdapterRegistry,
  type RuntimeAdapterHealthCheckInput,
  type RuntimeAdapterRegistry,
} from '@versatly/workgraph-runtime-adapter-core';
import { CursorCloudAdapter } from '@versatly/workgraph-adapter-cursor-cloud';
import {
  addWorkspaceOption,
  parsePositiveIntOption,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

export function registerAdapterCommands(program: Command): void {
  const adapterCmd = program
    .command('adapter')
    .description('Inspect and test runtime dispatch adapters');

  addWorkspaceOption(
    adapterCmd
      .command('list')
      .description('List runtime adapter names and aliases')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const registry = buildRuntimeAdapterRegistry();
        return {
          adapters: registry.list({ includeAliases: true }),
        };
      },
      (result) => result.adapters.map((entry) =>
        `${entry.name}${entry.aliases.length > 0 ? ` (aliases: ${entry.aliases.join(', ')})` : ''}`),
    ),
  );

  addWorkspaceOption(
    adapterCmd
      .command('test <adapterName>')
      .description('Run adapter health/connectivity check')
      .option('--timeout-ms <ms>', 'Health check timeout', '5000')
      .option('--webhook-url <url>', 'Webhook dispatch URL override')
      .option('--webhook-health-url <url>', 'Webhook health endpoint URL override')
      .option('--webhook-token <token>', 'Webhook token override')
      .option('--json', 'Emit structured JSON output'),
  ).action((adapterName, opts) =>
    runCommand(
      opts,
      async () => {
        const registry = buildRuntimeAdapterRegistry();
        const adapter = registry.resolve(adapterName);
        const workspacePath = resolveWorkspacePath(opts);
        const context: Record<string, unknown> = {};
        if (opts.webhookUrl) context.webhook_url = String(opts.webhookUrl);
        if (opts.webhookHealthUrl) context.webhook_health_url = String(opts.webhookHealthUrl);
        if (opts.webhookToken) context.webhook_token = String(opts.webhookToken);
        const healthInput: RuntimeAdapterHealthCheckInput = {
          workspacePath,
          timeoutMs: parsePositiveIntOption(opts.timeoutMs, 'timeout-ms'),
          context,
        };
        const health = await adapter.healthCheck(healthInput);
        return {
          adapter: registry.resolveCanonicalName(adapterName),
          health,
        };
      },
      (result) => [
        `Adapter: ${result.adapter}`,
        `Healthy: ${result.health.ok}`,
        `Message: ${result.health.message}`,
        ...(result.health.details ? [`Details: ${JSON.stringify(result.health.details)}`] : []),
      ],
    ),
  );
}

function buildRuntimeAdapterRegistry(): RuntimeAdapterRegistry {
  const registry = createDefaultRuntimeAdapterRegistry();
  registry.register('cursor-cloud', () => new CursorCloudAdapter(), {
    aliases: ['cursor'],
  });
  return registry;
}
