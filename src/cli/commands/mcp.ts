import { Command } from 'commander';
import * as workgraph from '../../index.js';
import {
  addWorkspaceOption,
  resolveWorkspacePath,
} from '../core.js';

export function registerMcpCommands(program: Command, defaultActor: string): void {
  const mcpCmd = program
    .command('mcp')
    .description('Run Workgraph MCP server');

  addWorkspaceOption(
    mcpCmd
      .command('serve')
      .description('Serve stdio MCP tools/resources for this workspace')
      .option('-a, --actor <name>', 'Default actor for MCP write tools', defaultActor)
      .option('--read-only', 'Disable all MCP write tools'),
  ).action(async (opts) => {
    const workspacePath = resolveWorkspacePath(opts);
    console.error(`Starting MCP server for workspace: ${workspacePath}`);
    await workgraph.mcpServer.startWorkgraphMcpServer({
      workspacePath,
      defaultActor: opts.actor,
      readOnly: !!opts.readOnly,
    });
  });
}
