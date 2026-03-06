import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import {
  addWorkspaceOption,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

export function registerSafetyCommands(program: Command, defaultActor: string): void {
  const safetyCmd = program
    .command('safety')
    .description('Continuous operations safety rails (rate limit, circuit breaker, kill switch)');

  addWorkspaceOption(
    safetyCmd
      .command('status')
      .description('Show current safety configuration and runtime state')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.safety.getSafetyStatus(workspacePath);
      },
      (result) => [
        `Blocked: ${result.blocked ? 'yes' : 'no'}`,
        ...(result.reasons.length > 0 ? result.reasons.map((reason) => `Reason: ${reason}`) : []),
        `Kill switch: ${result.config.killSwitch.engaged ? 'engaged' : 'released'}`,
        `Rate limit: enabled=${result.config.rateLimit.enabled} window=${result.config.rateLimit.windowSeconds}s max=${result.config.rateLimit.maxOperations} used=${result.config.runtime.rateLimitOperations}`,
        `Circuit breaker: enabled=${result.config.circuitBreaker.enabled} state=${result.config.runtime.circuitState} failures=${result.config.runtime.consecutiveFailures}`,
        `Updated at: ${result.config.updatedAt}`,
      ],
    ),
  );

  addWorkspaceOption(
    safetyCmd
      .command('pause')
      .description('Engage kill switch to pause autonomous operations')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--reason <text>', 'Optional pause reason')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          config: workgraph.safety.pauseSafetyOperations(workspacePath, opts.actor, opts.reason),
        };
      },
      (result) => [
        'Safety kill switch engaged.',
        `Reason: ${String(result.config.killSwitch.reason ?? 'none')}`,
        `Updated at: ${result.config.updatedAt}`,
      ],
    ),
  );

  addWorkspaceOption(
    safetyCmd
      .command('resume')
      .description('Release kill switch and resume autonomous operations')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          config: workgraph.safety.resumeSafetyOperations(workspacePath, opts.actor),
        };
      },
      (result) => [
        'Safety kill switch released.',
        `Updated at: ${result.config.updatedAt}`,
      ],
    ),
  );

  addWorkspaceOption(
    safetyCmd
      .command('reset')
      .description('Reset safety runtime counters and circuit state')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--full', 'Also clear kill switch state')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          config: workgraph.safety.resetSafetyRails(workspacePath, {
            actor: opts.actor,
            clearKillSwitch: !!opts.full,
          }),
        };
      },
      (result) => [
        'Safety runtime reset complete.',
        `Circuit state: ${result.config.runtime.circuitState}`,
        `Rate limit used: ${result.config.runtime.rateLimitOperations}`,
        `Kill switch: ${result.config.killSwitch.engaged ? 'engaged' : 'released'}`,
      ],
    ),
  );

  addWorkspaceOption(
    safetyCmd
      .command('log')
      .description('Show recent safety events from ledger')
      .option('--count <n>', 'Number of entries', '20')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const parsedCount = Number.parseInt(String(opts.count), 10);
        const count = Number.isFinite(parsedCount) ? Math.max(0, parsedCount) : 20;
        return {
          entries: workgraph.safety.listSafetyEvents(workspacePath, { count }),
          count,
        };
      },
      (result) => {
        if (result.entries.length === 0) return ['No safety events found.'];
        return result.entries.map((entry) => {
          const eventName = readEventName(entry);
          return `${entry.ts} ${eventName} actor=${entry.actor}`;
        });
      },
    ),
  );
}

function readEventName(entry: workgraph.LedgerEntry): string {
  const data = entry.data as Record<string, unknown> | undefined;
  const event = data?.event;
  return typeof event === 'string' && event.trim().length > 0 ? event : 'safety.unknown';
}
