import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

let cliBuilt = false;

function runCli(args: string[]): { ok: boolean; data?: unknown; error?: string } {
  ensureBuiltCli();
  const result = spawnSync('node', [path.resolve('bin/workgraph.js'), ...args], {
    encoding: 'utf-8',
  });
  const output = (result.stdout || result.stderr || '').trim();
  let parsed: { ok: boolean; data?: unknown; error?: string } | null = null;
  try {
    parsed = JSON.parse(output) as { ok: boolean; data?: unknown; error?: string };
  } catch {
    throw new Error(`CLI output was not valid JSON for args [${args.join(' ')}]: ${output}`);
  }
  return parsed;
}

function ensureBuiltCli(): void {
  if (cliBuilt) return;
  const result = spawnSync('npm', ['run', 'build', '--silent'], {
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`Failed to build CLI before compatibility test: ${result.stderr || result.stdout}`);
  }
  cliBuilt = true;
}

describe('CLI compatibility smoke', () => {
  beforeAll(() => {
    const build = spawnSync('npm', ['run', 'build', '--silent'], {
      encoding: 'utf-8',
    });
    if (build.status !== 0) {
      throw new Error(
        `Failed to build CLI for compatibility test.\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
      );
    }
  });

  it('keeps existing JSON envelope and legacy command behaviors', () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-cli-compat-'));
    try {
      const init = runCli(['init', workspacePath, '--json']);
      expect(init.ok).toBe(true);

      const create = runCli([
        'thread', 'create', 'Compatibility Thread',
        '-w', workspacePath,
        '--goal', 'Verify legacy flows',
        '--actor', 'agent-compat',
        '--json',
      ]);
      expect(create.ok).toBe(true);
      const createdThreadPath = ((create.data as { thread: { path: string } }).thread.path);
      const createdThreadEtag = String((create.data as { thread: { fields: { etag: string } } }).thread.fields.etag);

      const primitiveUpdate = runCli([
        'primitive', 'update', createdThreadPath,
        '-w', workspacePath,
        '--actor', 'agent-compat',
        '--set', 'priority=high',
        '--etag', createdThreadEtag,
        '--json',
      ]);
      expect(primitiveUpdate.ok).toBe(true);

      const list = runCli(['thread', 'list', '-w', workspacePath, '--json']);
      expect(list.ok).toBe(true);

      const claim = runCli([
        'thread', 'claim', 'threads/compatibility-thread.md',
        '-w', workspacePath,
        '--actor', 'agent-compat',
        '--json',
      ]);
      expect(claim.ok).toBe(true);

      const done = runCli([
        'thread', 'done', 'threads/compatibility-thread.md',
        '-w', workspacePath,
        '--actor', 'agent-compat',
        '--output', 'Completed in compatibility test',
        '--json',
      ]);
      expect(done.ok).toBe(true);

      const ledger = runCli(['ledger', 'show', '-w', workspacePath, '--count', '10', '--json']);
      expect(ledger.ok).toBe(true);

      const commandCenter = runCli([
        'command-center',
        '-w', workspacePath,
        '--output', 'ops/Command Center.md',
        '--json',
      ]);
      expect(commandCenter.ok).toBe(true);

      const dispatchCreate = runCli([
        'dispatch', 'create', 'Compatibility dispatch objective',
        '-w', workspacePath,
        '--actor', 'agent-compat',
        '--json',
      ]);
      expect(dispatchCreate.ok).toBe(true);
      const runId = String((dispatchCreate.data as { run: { id: string } }).run.id);

      const dispatchMark = runCli([
        'dispatch', 'mark', runId,
        '-w', workspacePath,
        '--actor', 'agent-compat',
        '--status', 'running',
        '--json',
      ]);
      expect(dispatchMark.ok).toBe(true);

      const dispatchHeartbeat = runCli([
        'dispatch', 'heartbeat', runId,
        '-w', workspacePath,
        '--actor', 'agent-compat',
        '--lease-minutes', '35',
        '--json',
      ]);
      expect(dispatchHeartbeat.ok).toBe(true);

      const dispatchHandoff = runCli([
        'dispatch', 'handoff', runId,
        '-w', workspacePath,
        '--actor', 'agent-compat',
        '--to', 'agent-specialist',
        '--reason', 'compatibility handoff',
        '--json',
      ]);
      expect(dispatchHandoff.ok).toBe(true);

      const dispatchReconcile = runCli([
        'dispatch', 'reconcile',
        '-w', workspacePath,
        '--actor', 'agent-compat',
        '--json',
      ]);
      expect(dispatchReconcile.ok).toBe(true);

      const agentHeartbeat = runCli([
        'agent', 'heartbeat', 'agent-compat',
        '-w', workspacePath,
        '--actor', 'agent-compat',
        '--status', 'online',
        '--capabilities', 'cli,testing',
        '--json',
      ]);
      expect(agentHeartbeat.ok).toBe(true);

      const agentList = runCli([
        'agent', 'list',
        '-w', workspacePath,
        '--json',
      ]);
      expect(agentList.ok).toBe(true);

      const skillWrite = runCli([
        'skill', 'write', 'compat-skill',
        '-w', workspacePath,
        '--actor', 'agent-compat',
        '--body', '# Compat Skill',
        '--json',
      ]);
      expect(skillWrite.ok).toBe(true);

      const skillLoad = runCli([
        'skill', 'load', 'compat-skill',
        '-w', workspacePath,
        '--json',
      ]);
      expect(skillLoad.ok).toBe(true);

      const integrationList = runCli([
        'integration', 'list',
        '-w', workspacePath,
        '--json',
      ]);
      expect(integrationList.ok).toBe(true);

      const integrationInstall = runCli([
        'integration', 'install', 'clawdapus',
        '-w', workspacePath,
        '--actor', 'agent-compat',
        '--source-url', 'data:text/plain,%23%20Clawdapus%0A',
        '--json',
      ]);
      expect(integrationInstall.ok).toBe(true);
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('documents new dispatch, agent, and primitive etag options in --help output', () => {
    const dispatchHelp = spawnSync('node', [path.resolve('bin/workgraph.js'), 'dispatch', '--help'], {
      encoding: 'utf-8',
    });
    expect(dispatchHelp.status).toBe(0);
    expect(dispatchHelp.stdout).toContain('heartbeat');
    expect(dispatchHelp.stdout).toContain('reconcile');
    expect(dispatchHelp.stdout).toContain('handoff');

    const agentHelp = spawnSync('node', [path.resolve('bin/workgraph.js'), 'agent', '--help'], {
      encoding: 'utf-8',
    });
    expect(agentHelp.status).toBe(0);
    expect(agentHelp.stdout).toContain('heartbeat');
    expect(agentHelp.stdout).toContain('list');

    const primitiveUpdateHelp = spawnSync('node', [path.resolve('bin/workgraph.js'), 'primitive', 'update', 'target.md', '--help'], {
      encoding: 'utf-8',
    });
    expect(primitiveUpdateHelp.status).toBe(0);
    expect(primitiveUpdateHelp.stdout).toContain('--etag');
  });
});
