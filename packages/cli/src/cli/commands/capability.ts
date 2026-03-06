import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import {
  addWorkspaceOption,
  csv,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

export function registerCapabilityCommands(program: Command, defaultActor: string): void {
  const capabilityCmd = program
    .command('capability')
    .description('Inspect agent capability registry and thread requirement matching');

  addWorkspaceOption(
    capabilityCmd
      .command('list')
      .description('List known capabilities and owning agents')
      .option('--agent <name>', 'Filter to one agent')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const registry = workgraph.capability.buildAgentCapabilityRegistry(workspacePath);
        const agentFilter = normalizeToken(opts.agent);
        const agents = agentFilter
          ? registry.agents.filter((entry) => entry.agentName === agentFilter)
          : registry.agents;
        const capabilities = agentFilter
          ? registry.capabilities.filter((entry) => entry.agents.includes(agentFilter))
          : registry.capabilities;
        return {
          generatedAt: registry.generatedAt,
          agents,
          capabilities,
          agentCount: agents.length,
          capabilityCount: capabilities.length,
        };
      },
      (result) => {
        if (result.agents.length === 0) return ['No agent capabilities found.'];
        return [
          `Agents: ${result.agentCount}`,
          `Capabilities: ${result.capabilityCount}`,
          ...result.agents.map((entry) =>
            `${entry.agentName} caps=${entry.capabilities.length} skills=${entry.skills.length} adapters=${entry.adapters.length}`),
        ];
      },
    ),
  );

  addWorkspaceOption(
    capabilityCmd
      .command('search <query>')
      .description('Search capabilities by token or agent identifier')
      .option('--agent <name>', 'Filter search results by one agent')
      .option('--json', 'Emit structured JSON output'),
  ).action((query, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const agentFilter = normalizeToken(opts.agent);
        const results = workgraph.capability.searchCapabilityRegistry(workspacePath, query)
          .filter((entry) => !agentFilter || entry.agents.includes(agentFilter));
        return {
          query: String(query),
          agent: agentFilter || undefined,
          results,
          count: results.length,
        };
      },
      (result) => {
        if (result.results.length === 0) return [`No capabilities matched "${result.query}".`];
        return [
          ...result.results.map((entry) => `${entry.capability} <- ${entry.agents.join(', ')}`),
          `${result.count} capability match(es)`,
        ];
      },
    ),
  );

  addWorkspaceOption(
    capabilityCmd
      .command('match <threadRef>')
      .description('Match one thread against an agent capability profile')
      .option('-a, --agent <name>', 'Agent identity', defaultActor)
      .option('--capabilities <items>', 'Comma-separated extra capabilities')
      .option('--skills <items>', 'Comma-separated extra skills')
      .option('--adapters <items>', 'Comma-separated extra adapters')
      .option('--json', 'Emit structured JSON output'),
  ).action((threadRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const normalizedAgent = normalizeToken(opts.agent ?? defaultActor);
        if (!normalizedAgent) {
          throw new Error('Agent name is required. Provide --agent.');
        }
        const threadInstance = workgraph.capability.resolveThreadInstance(workspacePath, threadRef);
        if (!threadInstance || threadInstance.type !== 'thread') {
          throw new Error(`Thread not found: ${threadRef}`);
        }

        const resolved = workgraph.capability.resolveAgentCapabilityProfile(workspacePath, normalizedAgent);
        const mergedCapabilities = dedupeStrings([
          ...resolved.capabilities,
          ...(csv(opts.capabilities) ?? []).map((item) => normalizeToken(item)),
        ]);
        const mergedSkills = dedupeStrings([
          ...resolved.skills,
          ...(csv(opts.skills) ?? []).map((item) => normalizeToken(item)),
        ]);
        const mergedAdapters = dedupeStrings([
          ...resolved.adapters,
          ...(csv(opts.adapters) ?? []).map((item) => normalizeToken(item)),
        ]);
        const profile = {
          ...resolved,
          capabilities: mergedCapabilities,
          skills: mergedSkills,
          adapters: mergedAdapters,
        };
        const match = workgraph.capability.matchThreadToCapabilityProfile(threadInstance, profile);

        return {
          thread: match.thread,
          profile,
          requirements: match.requirements,
          missing: match.missing,
          matched: match.matched,
        };
      },
      (result) => {
        const requirementSummary = [
          `capabilities=${result.requirements.capabilities.join(', ') || 'none'}`,
          `skills=${result.requirements.skills.join(', ') || 'none'}`,
          `adapters=${result.requirements.adapters.join(', ') || 'none'}`,
        ].join(' ');
        const missingSummary = [
          `capabilities=${result.missing.capabilities.join(', ') || 'none'}`,
          `skills=${result.missing.skills.join(', ') || 'none'}`,
          `adapters=${result.missing.adapters.join(', ') || 'none'}`,
        ].join(' ');
        return [
          `Thread: ${result.thread.path}`,
          `Agent: ${result.profile.agentName}`,
          `Matched: ${result.matched}`,
          `Requirements: ${requirementSummary}`,
          `Missing: ${missingSummary}`,
        ];
      },
    ),
  );
}

function normalizeToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
