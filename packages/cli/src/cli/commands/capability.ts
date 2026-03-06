import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import {
  addWorkspaceOption,
  csv,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

export function registerCapabilityCommands(program: Command): void {
  const capabilityCmd = program
    .command('capability')
    .description('Inspect and match agent capabilities');

  addWorkspaceOption(
    capabilityCmd
      .command('list')
      .description('List known capabilities across agents')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const capabilities = workgraph.capability.listCapabilityRegistry(workspacePath);
        return {
          capabilities,
          count: capabilities.length,
        };
      },
      (result) => {
        if (result.capabilities.length === 0) {
          return ['No capabilities declared by agents.'];
        }
        return [
          ...result.capabilities.map((entry) =>
            `${entry.name} versions=${entry.versions.join(',') || '*'} agents=${entry.agents.length}`,
          ),
          `${result.count} capability entr${result.count === 1 ? 'y' : 'ies'}`,
        ];
      },
    ),
  );

  addWorkspaceOption(
    capabilityCmd
      .command('search <name>')
      .description('Find agents that declare a capability')
      .option('--json', 'Emit structured JSON output'),
  ).action((name, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.capability.searchAgentsByCapability(workspacePath, name);
      },
      (result) => {
        if (result.matches.length === 0) {
          return [`No agents found for capability "${result.query}".`];
        }
        return [
          ...result.matches.map((match) =>
            `${match.agent} -> ${match.capability.name}@${match.capability.version} confidence=${match.capability.confidence}`,
          ),
          `${result.matches.length} match${result.matches.length === 1 ? '' : 'es'}`,
        ];
      },
    ),
  );

  addWorkspaceOption(
    capabilityCmd
      .command('match <threadRef>')
      .description('Find best agent match for a thread')
      .option('--agents <items>', 'Optional comma-separated candidate agents')
      .option('--include-offline', 'Include offline agents in candidate matching')
      .option('--json', 'Emit structured JSON output'),
  ).action((threadRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.capability.matchThreadToBestAgent(workspacePath, threadRef, {
          candidateAgents: csv(opts.agents),
          includeOfflineAgents: !!opts.includeOffline,
        });
      },
      (result) => {
        const lines = [
          `Thread: ${result.threadPath}`,
          `Required: ${result.requiredCapabilities.map((entry) => `${entry.name}@${entry.version}`).join(', ') || 'none'}`,
        ];
        if (result.explicitAssignee) {
          lines.push(`Explicit assignee: ${result.explicitAssignee}`);
        }
        if (result.best) {
          lines.push(
            `Best match: ${result.best.agent} score=${result.best.score} matched=${result.best.matchedCapabilities.length}/${result.requiredCapabilities.length || 0}`,
          );
        } else {
          lines.push(`Manual assignment required: ${result.reason ?? 'No matching capability profile found.'}`);
        }
        return lines;
      },
    ),
  );
}
