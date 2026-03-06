import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import {
  addWorkspaceOption,
  parsePositiveIntegerOption,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

export function registerCapabilityCommands(program: Command, _defaultActor: string): void {
  const capabilityCmd = program
    .command('capability')
    .description('Inspect capability registry and route threads to suitable agents');

  addWorkspaceOption(
    capabilityCmd
      .command('list')
      .description('List indexed capabilities and their owning agents')
      .option('--agent <name>', 'Filter to capabilities owned by one agent')
      .option('--limit <n>', 'Maximum capability entries to return', '100')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const registry = workgraph.capability.buildCapabilityRegistry(workspacePath);
        const normalizedAgentFilter = normalizeToken(opts.agent);
        const filteredCapabilities = normalizedAgentFilter
          ? registry.capabilities.filter((entry) => entry.agents.includes(normalizedAgentFilter))
          : registry.capabilities;
        const limit = parsePositiveIntegerOption(opts.limit, 'limit');
        return {
          generatedAt: registry.generatedAt,
          capabilities: filteredCapabilities.slice(0, limit),
          totalCapabilities: filteredCapabilities.length,
          totalAgents: registry.agents.length,
        };
      },
      (result) => {
        if (result.capabilities.length === 0) {
          return ['No capabilities indexed.'];
        }
        return [
          ...result.capabilities.map((entry) => `${entry.capability} -> ${entry.agents.join(', ')}`),
          `${result.totalCapabilities} capability entr${result.totalCapabilities === 1 ? 'y' : 'ies'} across ${result.totalAgents} agent(s)`,
        ];
      },
    ),
  );

  addWorkspaceOption(
    capabilityCmd
      .command('search <query>')
      .description('Search capability registry by capability token or agent name')
      .option('--limit <n>', 'Maximum capabilities/agents to return', '20')
      .option('--json', 'Emit structured JSON output'),
  ).action((query, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const result = workgraph.capability.searchCapabilities(workspacePath, query);
        const limit = parsePositiveIntegerOption(opts.limit, 'limit');
        return {
          query: result.query,
          capabilities: result.capabilities.slice(0, limit),
          agents: result.agents.slice(0, limit),
        };
      },
      (result) => {
        if (result.capabilities.length === 0 && result.agents.length === 0) {
          return [`No capability matches for "${result.query}".`];
        }
        return [
          `Query: ${result.query}`,
          ...result.capabilities.map((entry) => `capability ${entry.capability} -> ${entry.agents.join(', ')}`),
          ...result.agents.map((profile) =>
            `agent ${profile.agentName} (${profile.capabilities.length} capabilities)`),
        ];
      },
    ),
  );

  addWorkspaceOption(
    capabilityCmd
      .command('match <threadRef>')
      .description('Match thread required capabilities to indexed agents')
      .option('--include-unmatched', 'Include agents that do not satisfy requirements')
      .option('--json', 'Emit structured JSON output'),
  ).action((threadRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.capability.matchThreadToAgents(workspacePath, threadRef);
      },
      (result) => {
        const matched = result.matches.filter((entry) => entry.matched);
        const unmatched = result.matches.filter((entry) => !entry.matched);
        const requiredLine = result.requiredCapabilities.length > 0
          ? result.requiredCapabilities.join(', ')
          : 'none';
        const lines = [
          `Thread: ${result.thread.path}`,
          `Required capabilities: ${requiredLine}`,
          `Matched agents: ${matched.length}/${result.matches.length}`,
          ...matched.map((entry) => `match ${entry.agent.agentName}`),
        ];
        if (opts.includeUnmatched) {
          lines.push(...unmatched.map((entry) =>
            `miss ${entry.agent.agentName} missing=${entry.missingCapabilities.join(', ')}`));
        }
        return lines;
      },
    ),
  );
}

function normalizeToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}
