import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import {
  addWorkspaceOption,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

export function registerPortabilityCommands(program: Command): void {
  addWorkspaceOption(
    program
      .command('export <snapshotPath>')
      .description('Export current workspace as tar.gz snapshot')
      .option('--json', 'Emit structured JSON output'),
  ).action((snapshotPath, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.exportImport.exportWorkspaceSnapshot(workspacePath, snapshotPath);
      },
      (result) => [
        `Exported workspace snapshot: ${result.snapshotPath}`,
        `Workspace: ${result.workspacePath}`,
        `Bytes: ${result.bytes}`,
      ],
    ),
  );

  addWorkspaceOption(
    program
      .command('import <snapshotPath>')
      .description('Import a tar.gz snapshot into a workspace')
      .option('--overwrite', 'Replace existing workspace contents')
      .option('--json', 'Emit structured JSON output'),
  ).action((snapshotPath, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.exportImport.importWorkspaceSnapshot(snapshotPath, workspacePath, {
          overwrite: !!opts.overwrite,
        });
      },
      (result) => [
        `Imported workspace snapshot: ${result.snapshotPath}`,
        `Workspace: ${result.workspacePath}`,
        `Files imported: ${result.filesImported}`,
      ],
    ),
  );

  program
    .command('env')
    .description('Show runtime environment and feature flags')
    .option('--flag <name>', 'Resolve one feature flag by name')
    .option('--json', 'Emit structured JSON output')
    .action((opts) =>
      runCommand(
        opts,
        () => {
          const info = workgraph.environment.getEnvironmentInfo();
          const selectedFlag = opts.flag
            ? {
                name: String(opts.flag),
                enabled: workgraph.environment.isFeatureEnabled(String(opts.flag)),
              }
            : undefined;
          return {
            ...info,
            selectedFlag,
          };
        },
        (result) => [
          `Environment: ${result.environment} (${result.source})`,
          `Feature flags: ${Object.keys(result.featureFlags).length}`,
          ...Object.entries(result.featureFlags)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, enabled]) => `- ${name}=${enabled}`),
          ...(result.selectedFlag
            ? [`Selected flag: ${result.selectedFlag.name}=${result.selectedFlag.enabled}`]
            : []),
        ],
      ),
    );
}
