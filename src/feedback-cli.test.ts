import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

interface CliJsonEnvelope {
  ok: boolean;
  dryRun?: boolean;
  data?: any;
  error?: string;
}

function runCli(args: string[]): CliJsonEnvelope {
  const result = spawnSync('node', [path.resolve('bin/workgraph.js'), ...args], {
    encoding: 'utf-8',
  });
  const rawOutput = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  let parsed: CliJsonEnvelope | null = null;
  try {
    parsed = JSON.parse(rawOutput) as CliJsonEnvelope;
  } catch {
    throw new Error(`CLI output is not valid JSON for args [${args.join(' ')}]: ${rawOutput}`);
  }
  return parsed;
}

describe('feedback hardening: field discovery, dry-run, daemon process model', () => {
  it('exposes primitive schema and supports --description alias for thread create', () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-feedback-schema-'));
    try {
      const init = runCli(['init', workspacePath, '--json']);
      expect(init.ok).toBe(true);

      const schema = runCli(['primitive', 'schema', 'thread', '-w', workspacePath, '--json']);
      expect(schema.ok).toBe(true);
      expect(schema.data.type).toBe('thread');
      expect(schema.data.fields.some((field: { name: string }) => field.name === 'goal')).toBe(true);

      const create = runCli([
        'thread', 'create', 'Thread via description alias',
        '-w', workspacePath,
        '--description', 'goal from description alias',
        '--actor', 'alias-agent',
        '--json',
      ]);
      expect(create.ok).toBe(true);
      expect(create.data.thread.path).toBe('threads/thread-via-description-alias.md');
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('supports --dry-run without mutating workspace state', () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-feedback-dry-run-'));
    try {
      const init = runCli(['init', workspacePath, '--json']);
      expect(init.ok).toBe(true);

      const createDryRun = runCli([
        'thread', 'create', 'Dry run thread',
        '-w', workspacePath,
        '--goal', 'should not persist',
        '--actor', 'dry-run-agent',
        '--dry-run',
        '--json',
      ]);
      expect(createDryRun.ok).toBe(true);
      expect(createDryRun.dryRun).toBe(true);

      const list = runCli(['thread', 'list', '-w', workspacePath, '--json']);
      expect(list.ok).toBe(true);
      expect(list.data.count).toBe(0);
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('runs autonomy in daemon mode with explicit start/status/stop lifecycle', () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-feedback-daemon-'));
    try {
      const init = runCli(['init', workspacePath, '--json']);
      expect(init.ok).toBe(true);

      const create = runCli([
        'thread', 'create', 'Daemon thread',
        '-w', workspacePath,
        '--goal', 'daemon lifecycle validation',
        '--actor', 'daemon-agent',
        '--json',
      ]);
      expect(create.ok).toBe(true);

      const start = runCli([
        'autonomy', 'daemon', 'start',
        '-w', workspacePath,
        '--actor', 'daemon-agent',
        '--poll-ms', '200',
        '--max-steps', '50',
        '--step-delay-ms', '0',
        '--max-cycles', '100',
        '--json',
      ]);
      expect(start.ok).toBe(true);
      expect(start.data.running).toBe(true);
      expect(typeof start.data.pid).toBe('number');

      const status = runCli(['autonomy', 'daemon', 'status', '-w', workspacePath, '--json']);
      expect(status.ok).toBe(true);
      expect(status.data.running).toBe(true);

      const stop = runCli(['autonomy', 'daemon', 'stop', '-w', workspacePath, '--timeout-ms', '3000', '--json']);
      expect(stop.ok).toBe(true);
      expect(stop.data.stopped).toBe(true);

      const finalStatus = runCli(['autonomy', 'daemon', 'status', '-w', workspacePath, '--json']);
      expect(finalStatus.ok).toBe(true);
      expect(finalStatus.data.running).toBe(false);
    } finally {
      runCli(['autonomy', 'daemon', 'stop', '-w', workspacePath, '--timeout-ms', '3000', '--json']);
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
