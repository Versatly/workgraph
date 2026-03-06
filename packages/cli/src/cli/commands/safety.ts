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
    .description('Continuous ops safety rails (rate limits, breakers, kill switch, audit)');

  addWorkspaceOption(
    safetyCmd
      .command('status')
      .description('Show kill switch, rate limits, and circuit breaker state')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.safety.safetyStatus(workspacePath);
      },
      (result) => [
        `Emergency stop: ${result.emergencyStop ? 'ON' : 'OFF'}`,
        `Rate limits: minute=${result.rateLimiting.maxDispatchesPerMinutePerAgent} hour=${result.rateLimiting.maxDispatchesPerHourPerAgent} concurrent=${result.rateLimiting.maxConcurrentRunsPerAgent}`,
        `Circuit breaker threshold: ${result.circuitBreaker.threshold}`,
        `Agent circuits: ${result.circuitBreaker.agents.filter((entry) => entry.open).length} open / ${result.circuitBreaker.agents.length} tracked`,
        `Trigger circuits: ${result.circuitBreaker.triggers.filter((entry) => entry.open).length} open / ${result.circuitBreaker.triggers.length} tracked`,
      ],
    ),
  );

  addWorkspaceOption(
    safetyCmd
      .command('pause')
      .description('Enable kill switch to halt automated dispatches')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.safety.setEmergencyStop(workspacePath, true, opts.actor);
      },
      () => ['Automated dispatches paused (kill switch ON).'],
    ),
  );

  addWorkspaceOption(
    safetyCmd
      .command('resume')
      .description('Disable kill switch to resume automated dispatches')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.safety.setEmergencyStop(workspacePath, false, opts.actor);
      },
      () => ['Automated dispatches resumed (kill switch OFF).'],
    ),
  );

  addWorkspaceOption(
    safetyCmd
      .command('reset <target>')
      .description('Reset circuit breaker counters for an agent name or trigger path')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((target, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.safety.resetSafetyCircuit(workspacePath, target, opts.actor);
      },
      (result) => [
        `Reset target: ${result.target} (${result.targetType})`,
        `Counters reset: ${result.reset}`,
        `Trigger re-enabled: ${result.reEnabledTrigger}`,
      ],
    ),
  );

  addWorkspaceOption(
    safetyCmd
      .command('log')
      .description('Show safety events from the append-only ledger')
      .option('--agent <name>', 'Filter to one agent')
      .option('--since <iso>', 'Filter events on/after ISO timestamp')
      .option('--limit <n>', 'Limit number of events')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          events: workgraph.safety.readSafetyLog(workspacePath, {
            agent: opts.agent,
            since: opts.since,
            limit: opts.limit ? Number.parseInt(String(opts.limit), 10) : undefined,
          }),
        };
      },
      (result) => {
        if (result.events.length === 0) return ['No safety events found.'];
        return result.events.map((event) =>
          `${event.ts} ${event.event} actor=${event.actor}${event.agent ? ` agent=${event.agent}` : ''}${event.triggerPath ? ` trigger=${event.triggerPath}` : ''}`,
        );
      },
    ),
  );
}
