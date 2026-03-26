import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { policy as policyModule, workspace as workspaceModule } from '@versatly/workgraph-kernel';
import { startWorkgraphMcpHttpServer } from '@versatly/workgraph-mcp-server';
import { ensureCliBuiltForTests } from '../helpers/cli-build.js';

interface CliEnvelope {
  ok: boolean;
  data?: unknown;
  error?: string;
}

const policy = policyModule;
const workspace = workspaceModule;

async function runCli(args: string[]): Promise<CliEnvelope> {
  ensureCliBuiltForTests();
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.resolve('bin/workgraph.js'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', () => {
      const output = (stdout || stderr || '').trim();
      try {
        resolve(JSON.parse(output) as CliEnvelope);
      } catch {
        reject(new Error(`CLI output was not valid JSON for args [${args.join(' ')}]: ${output}`));
      }
    });
  });
}

describe('CLI remote/API mode', () => {
  beforeAll(() => {
    ensureCliBuiltForTests();
  });

  it('routes key commands through MCP HTTP when --api-url is set', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-cli-remote-'));
    const init = workspace.initWorkspace(workspacePath, {
      createReadme: false,
      createBases: false,
    });
    policy.upsertParty(workspacePath, 'remote-admin', {
      roles: ['operator'],
      capabilities: ['mcp:write', 'thread:create', 'thread:claim', 'thread:done', 'checkpoint:create', 'agent:heartbeat'],
    }, {
      actor: 'remote-admin',
      skipAuthorization: true,
    });

    const handle = await startWorkgraphMcpHttpServer({
      workspacePath,
      defaultActor: 'remote-admin',
      host: '127.0.0.1',
      port: 0,
      bearerToken: 'remote-test-token',
    });

    const remoteWorkspacePath = path.join(os.tmpdir(), 'wg-cli-remote-nonexistent-workspace');
    try {
      const commonRemoteArgs = ['--api-url', handle.url, '--api-key', 'remote-test-token', '-w', remoteWorkspacePath];

      const threadCreate = await runCli([
        'thread', 'create', 'Remote API Thread',
        ...commonRemoteArgs,
        '--goal', 'Validate remote thread create',
        '--actor', 'remote-admin',
        '--json',
      ]);
      if (!threadCreate.ok) {
        throw new Error(`thread create failed: ${JSON.stringify(threadCreate)}`);
      }
      const threadPath = String((threadCreate.data as { thread: { path: string } }).thread.path);

      const threadList = await runCli([
        'thread', 'list',
        ...commonRemoteArgs,
        '--json',
      ]);
      expect(threadList.ok).toBe(true);
      expect(((threadList.data as { count: number }).count) >= 1).toBe(true);

      const threadNext = await runCli([
        'thread', 'next',
        ...commonRemoteArgs,
        '--actor', 'remote-admin',
        '--json',
      ]);
      expect(threadNext.ok).toBe(true);

      const threadClaim = await runCli([
        'thread', 'claim', threadPath,
        ...commonRemoteArgs,
        '--actor', 'remote-admin',
        '--json',
      ]);
      expect(threadClaim.ok).toBe(true);

      const threadDone = await runCli([
        'thread', 'done', threadPath,
        ...commonRemoteArgs,
        '--actor', 'remote-admin',
        '--output', 'Finished via remote API mode https://cursor.com/remote-proof',
        '--json',
      ]);
      expect(threadDone.ok, JSON.stringify(threadDone)).toBe(true);

      const status = await runCli([
        'status',
        ...commonRemoteArgs,
        '--json',
      ]);
      expect(status.ok).toBe(true);

      const brief = await runCli([
        'brief',
        ...commonRemoteArgs,
        '--actor', 'remote-admin',
        '--json',
      ]);
      expect(brief.ok).toBe(true);

      const checkpoint = await runCli([
        'checkpoint', 'Remote checkpoint summary',
        ...commonRemoteArgs,
        '--actor', 'remote-admin',
        '--next', 'finalize validation',
        '--json',
      ]);
      expect(checkpoint.ok).toBe(true);

      const register = await runCli([
        'agent', 'register', 'remote-agent',
        ...commonRemoteArgs,
        '--actor', 'remote-admin',
        '--token', init.bootstrapTrustToken,
        '--json',
      ]);
      expect(register.ok).toBe(true);

      const heartbeat = await runCli([
        'agent', 'heartbeat', 'remote-agent',
        ...commonRemoteArgs,
        '--actor', 'remote-admin',
        '--status', 'online',
        '--json',
      ]);
      expect(heartbeat.ok).toBe(true);

      const agentList = await runCli([
        'agent', 'list',
        ...commonRemoteArgs,
        '--json',
      ]);
      expect(agentList.ok).toBe(true);
      expect(((agentList.data as { count: number }).count) >= 1).toBe(true);

      const search = await runCli([
        'search', 'Remote API Thread',
        ...commonRemoteArgs,
        '--json',
      ]);
      expect(search.ok).toBe(true);
      expect(((search.data as { count: number }).count) >= 1).toBe(true);

      const query = await runCli([
        'query',
        ...commonRemoteArgs,
        '--type', 'thread',
        '--json',
      ]);
      expect(query.ok).toBe(true);
      expect(((query.data as { count: number }).count) >= 1).toBe(true);

      const lensList = await runCli([
        'lens', 'list',
        ...commonRemoteArgs,
        '--json',
      ]);
      expect(lensList.ok).toBe(true);
      expect(((lensList.data as { lenses: unknown[] }).lenses.length) > 0).toBe(true);

      const lensShow = await runCli([
        'lens', 'show', 'my-work',
        ...commonRemoteArgs,
        '--actor', 'remote-admin',
        '--json',
      ]);
      expect(lensShow.ok).toBe(true);

      const remoteTest = await runCli([
        'remote', 'test',
        '--api-url', handle.url,
        '--api-key', 'remote-test-token',
        '--json',
      ]);
      expect(remoteTest.ok).toBe(true);
      expect(((remoteTest.data as { toolCount: number }).toolCount) > 0).toBe(true);
    } finally {
      await handle.close();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  }, 60_000);
});
