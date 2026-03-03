import path from 'node:path';
import { Command } from 'commander';
import * as workgraph from '../../../../kernel/src/index.js';
import {
  addWorkspaceOption,
  csv,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

export function registerAutonomyCommands(program: Command, defaultActor: string): void {
  const autonomyCmd = program
    .command('autonomy')
    .description('Run long-lived autonomous collaboration loops');

  addWorkspaceOption(
    autonomyCmd
      .command('run')
      .description('Run autonomy cycles (trigger engine + ready-thread execution)')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--adapter <name>', 'Dispatch adapter name', 'cursor-cloud')
      .option('--agents <actors>', 'Comma-separated autonomous worker identities')
      .option('--watch', 'Run continuously instead of stopping when idle')
      .option('--poll-ms <ms>', 'Cycle poll interval', '2000')
      .option('--max-cycles <n>', 'Maximum cycles before exit')
      .option('--max-idle-cycles <n>', 'Idle cycles before exit in non-watch mode', '2')
      .option('--max-steps <n>', 'Maximum adapter scheduler steps', '200')
      .option('--step-delay-ms <ms>', 'Adapter scheduler delay', '25')
      .option('--space <spaceRef>', 'Restrict autonomy to one space')
      .option('--heartbeat-file <path>', 'Write daemon heartbeat JSON to this path')
      .option('--no-execute-triggers', 'Disable trigger engine actions')
      .option('--no-execute-ready-threads', 'Disable ready-thread dispatch execution')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      async () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.autonomy.runAutonomyLoop(workspacePath, {
          actor: opts.actor,
          adapter: opts.adapter,
          agents: csv(opts.agents),
          watch: !!opts.watch,
          pollMs: Number.parseInt(String(opts.pollMs), 10),
          maxCycles: opts.maxCycles ? Number.parseInt(String(opts.maxCycles), 10) : undefined,
          maxIdleCycles: Number.parseInt(String(opts.maxIdleCycles), 10),
          maxSteps: Number.parseInt(String(opts.maxSteps), 10),
          stepDelayMs: Number.parseInt(String(opts.stepDelayMs), 10),
          space: opts.space,
          heartbeatFile: opts.heartbeatFile,
          executeTriggers: opts.executeTriggers,
          executeReadyThreads: opts.executeReadyThreads,
        });
      },
      (result) => [
        `Cycles: ${result.cycles.length}`,
        `Final ready threads: ${result.finalReadyThreads}`,
        `Final drift status: ${result.finalDriftOk ? 'ok' : 'issues'}`,
        ...result.cycles.map((cycle) =>
          `Cycle ${cycle.cycle}: ready=${cycle.readyThreads} trigger_actions=${cycle.triggerActions} run=${cycle.runStatus ?? 'none'} drift_issues=${cycle.driftIssues}`,
        ),
      ],
    ),
  );

  const autonomyDaemonCmd = autonomyCmd
    .command('daemon')
    .description('Manage autonomy process lifecycle (pid + heartbeat + logs)');

  addWorkspaceOption(
    autonomyDaemonCmd
      .command('start')
      .description('Start autonomy in detached daemon mode')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--adapter <name>', 'Dispatch adapter name', 'cursor-cloud')
      .option('--agents <actors>', 'Comma-separated autonomous worker identities')
      .option('--poll-ms <ms>', 'Cycle poll interval', '2000')
      .option('--max-cycles <n>', 'Maximum cycles before daemon exits')
      .option('--max-steps <n>', 'Maximum adapter scheduler steps', '200')
      .option('--step-delay-ms <ms>', 'Adapter scheduler delay', '25')
      .option('--space <spaceRef>', 'Restrict autonomy to one space')
      .option('--log-path <path>', 'Daemon log file path (workspace-relative)')
      .option('--heartbeat-path <path>', 'Heartbeat file path (workspace-relative)')
      .option('--no-execute-triggers', 'Disable trigger engine actions')
      .option('--no-execute-ready-threads', 'Disable ready-thread dispatch execution')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.autonomyDaemon.startAutonomyDaemon(workspacePath, {
          cliEntrypointPath: process.argv[1] ?? path.resolve('bin/workgraph.js'),
          actor: opts.actor,
          adapter: opts.adapter,
          agents: csv(opts.agents),
          pollMs: Number.parseInt(String(opts.pollMs), 10),
          maxCycles: opts.maxCycles ? Number.parseInt(String(opts.maxCycles), 10) : undefined,
          maxSteps: Number.parseInt(String(opts.maxSteps), 10),
          stepDelayMs: Number.parseInt(String(opts.stepDelayMs), 10),
          space: opts.space,
          logPath: opts.logPath,
          heartbeatPath: opts.heartbeatPath,
          executeTriggers: opts.executeTriggers,
          executeReadyThreads: opts.executeReadyThreads,
        });
      },
      (result) => [
        `Daemon running: ${result.running}`,
        ...(result.pid ? [`PID: ${result.pid}`] : []),
        `PID file: ${result.pidPath}`,
        `Heartbeat: ${result.heartbeatPath}`,
        `Log: ${result.logPath}`,
      ],
    ),
  );

  addWorkspaceOption(
    autonomyDaemonCmd
      .command('status')
      .description('Show autonomy daemon status')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.autonomyDaemon.readAutonomyDaemonStatus(workspacePath);
      },
      (result) => [
        `Daemon running: ${result.running}`,
        ...(result.pid ? [`PID: ${result.pid}`] : []),
        ...(result.heartbeat ? [`Last heartbeat: ${result.heartbeat.ts}`] : ['Last heartbeat: none']),
        `PID file: ${result.pidPath}`,
        `Heartbeat: ${result.heartbeatPath}`,
        `Log: ${result.logPath}`,
      ],
    ),
  );

  addWorkspaceOption(
    autonomyDaemonCmd
      .command('stop')
      .description('Stop autonomy daemon by PID')
      .option('--signal <signal>', 'Signal for graceful stop', 'SIGTERM')
      .option('--timeout-ms <ms>', 'Graceful wait timeout', '5000')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      async () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.autonomyDaemon.stopAutonomyDaemon(workspacePath, {
          signal: String(opts.signal) as NodeJS.Signals,
          timeoutMs: Number.parseInt(String(opts.timeoutMs), 10),
        });
      },
      (result) => [
        `Stopped: ${result.stopped}`,
        `Previously running: ${result.previouslyRunning}`,
        ...(result.pid ? [`PID: ${result.pid}`] : []),
        `Daemon running now: ${result.status.running}`,
      ],
    ),
  );
}
