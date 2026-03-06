import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureCliBuiltForTests } from '../helpers/cli-build.js';

interface CliEnvelope {
  ok: boolean;
  data?: unknown;
  error?: string;
}

function runCli(args: string[]): CliEnvelope {
  ensureCliBuiltForTests();
  const result = spawnSync('node', [path.resolve('bin/workgraph.js'), ...args], {
    encoding: 'utf-8',
  });
  const output = (result.stdout || result.stderr || '').trim();
  try {
    return JSON.parse(output) as CliEnvelope;
  } catch {
    throw new Error(`CLI output was not valid JSON for args [${args.join(' ')}]: ${output}`);
  }
}

describe('portability CLI commands', () => {
  beforeAll(() => {
    ensureCliBuiltForTests();
  });

  it('supports env/export/import commands end-to-end', () => {
    const sourceWorkspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-portability-source-'));
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-portability-cli-'));
    const importedWorkspacePath = path.join(tempRoot, 'imported-workspace');
    const snapshotPath = path.join(tempRoot, 'workspace.tar.gz');

    try {
      const init = runCli(['init', sourceWorkspacePath, '--json']);
      expect(init.ok).toBe(true);

      const env = runCli(['env', '--json']);
      expect(env.ok).toBe(true);
      expect((env.data as { environment: string }).environment.length).toBeGreaterThan(0);

      const exportResult = runCli([
        'export',
        snapshotPath,
        '-w',
        sourceWorkspacePath,
        '--json',
      ]);
      expect(exportResult.ok).toBe(true);
      expect(fs.existsSync(snapshotPath)).toBe(true);

      const importResult = runCli([
        'import',
        snapshotPath,
        '-w',
        importedWorkspacePath,
        '--json',
      ]);
      expect(importResult.ok).toBe(true);
      expect(fs.existsSync(path.join(importedWorkspacePath, '.workgraph.json'))).toBe(true);

      const listThreads = runCli(['thread', 'list', '-w', importedWorkspacePath, '--json']);
      expect(listThreads.ok).toBe(true);
    } finally {
      fs.rmSync(sourceWorkspacePath, { recursive: true, force: true });
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('exposes portability commands in help output', () => {
    const help = spawnSync('node', [path.resolve('bin/workgraph.js'), '--help'], {
      encoding: 'utf-8',
    });

    expect(help.status).toBe(0);
    expect(help.stdout).toContain('export');
    expect(help.stdout).toContain('import');
    expect(help.stdout).toContain('env');
  });
});
