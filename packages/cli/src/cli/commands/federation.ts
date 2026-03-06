import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import {
  addWorkspaceOption,
  csv,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

export function registerFederationCommands(program: Command, threadCmd: Command, defaultActor: string): void {
  const federationCmd = program
    .command('federation')
    .description('Manage cross-workspace federation remotes and sync state');

  addWorkspaceOption(
    federationCmd
      .command('add <workspaceId> <remoteWorkspacePath>')
      .description('Add or update a federated remote workspace')
      .option('--name <name>', 'Friendly display name')
      .option('--tags <tags>', 'Comma-separated tags')
      .option('--disabled', 'Store remote as disabled')
      .option('--json', 'Emit structured JSON output'),
  ).action((workspaceId, remoteWorkspacePath, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.federation.addRemoteWorkspace(workspacePath, {
          id: workspaceId,
          path: remoteWorkspacePath,
          name: opts.name,
          enabled: !opts.disabled,
          tags: csv(opts.tags),
        });
      },
      (result) => [
        `${result.created ? 'Added' : 'Updated'} federation remote: ${result.remote.id}`,
        `Path: ${result.remote.path}`,
        `Enabled: ${result.remote.enabled}`,
        `Config: ${result.configPath}`,
      ],
    ),
  );

  addWorkspaceOption(
    federationCmd
      .command('remove <workspaceId>')
      .description('Remove a federated remote workspace')
      .option('--json', 'Emit structured JSON output'),
  ).action((workspaceId, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.federation.removeRemoteWorkspace(workspacePath, workspaceId);
      },
      (result) => result.changed
        ? [
            `Removed federation remote: ${result.removed?.id ?? 'unknown'}`,
            `Config: ${result.configPath}`,
          ]
        : [`No federation remote found for id: ${workspaceId}`],
    ),
  );

  addWorkspaceOption(
    federationCmd
      .command('list')
      .description('List configured federation remotes')
      .option('--enabled-only', 'Only show enabled remotes')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const remotes = workgraph.federation.listRemoteWorkspaces(workspacePath, {
          includeDisabled: !opts.enabledOnly,
        });
        return {
          remotes,
          count: remotes.length,
        };
      },
      (result) => {
        if (result.remotes.length === 0) return ['No federation remotes configured.'];
        return [
          ...result.remotes.map((remote) =>
            `${remote.enabled ? '[enabled]' : '[disabled]'} ${remote.id} ${remote.path}`),
          `${result.count} remote(s)`,
        ];
      },
    ),
  );

  addWorkspaceOption(
    federationCmd
      .command('sync')
      .description('Sync metadata from federated remote workspaces')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--remote <ids>', 'Comma-separated remote ids to sync')
      .option('--include-disabled', 'Include disabled remotes')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.federation.syncFederation(workspacePath, opts.actor, {
          remoteIds: csv(opts.remote),
          includeDisabled: !!opts.includeDisabled,
        });
      },
      (result) => [
        `Synced federation at: ${result.syncedAt}`,
        `Actor: ${result.actor}`,
        ...result.remotes.map((remote) =>
          `${remote.id} ${remote.status} threads=${remote.threadCount} open=${remote.openThreadCount}${remote.error ? ` error=${remote.error}` : ''}`),
      ],
    ),
  );

  addWorkspaceOption(
    threadCmd
      .command('link <threadRef> <remoteWorkspaceId> <remoteThreadRef>')
      .description('Link a local thread to a remote federated thread')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((threadRef, remoteWorkspaceId, remoteThreadRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.federation.linkThreadToRemoteWorkspace(
          workspacePath,
          threadRef,
          remoteWorkspaceId,
          remoteThreadRef,
          opts.actor,
        );
      },
      (result) => [
        `${result.created ? 'Linked' : 'Already linked'} thread: ${result.thread.path}`,
        `Federation link: ${result.link}`,
      ],
    ),
  );
}
