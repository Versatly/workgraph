import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

function runCli(args: string[]): { ok: boolean; data?: unknown; error?: string } {
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

describe('CLI compatibility smoke', () => {
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
});
