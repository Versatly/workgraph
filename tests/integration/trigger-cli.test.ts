import { describe, it, expect, beforeAll } from 'vitest';
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

describe('trigger CLI programmable primitives', () => {
  beforeAll(() => {
    ensureCliBuiltForTests();
  });

  it('supports trigger CRUD, evaluate, and history commands', () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-trigger-cli-'));
    try {
      const init = runCli(['init', workspacePath, '--json']);
      expect(init.ok).toBe(true);

      const create = runCli([
        'trigger', 'create', 'CLI Manual Trigger',
        '-w', workspacePath,
        '--actor', 'system',
        '--type', 'manual',
        '--condition', '{"type":"manual"}',
        '--objective', 'Run CLI manual dispatch',
        '--cooldown', '45',
        '--json',
      ]);
      expect(create.ok).toBe(true);
      const triggerPath = String((create.data as { trigger: { path: string } }).trigger.path);

      const list = runCli(['trigger', 'list', '-w', workspacePath, '--json']);
      expect(list.ok).toBe(true);
      expect(((list.data as { count: number }).count) >= 1).toBe(true);

      const show = runCli(['trigger', 'show', triggerPath, '-w', workspacePath, '--json']);
      expect(show.ok).toBe(true);
      expect((show.data as { trigger: { fields: { type: string } } }).trigger.fields.type).toBe('manual');

      const disable = runCli([
        'trigger', 'disable', triggerPath,
        '-w', workspacePath,
        '--actor', 'system',
        '--json',
      ]);
      expect(disable.ok).toBe(true);

      const enable = runCli([
        'trigger', 'enable', triggerPath,
        '-w', workspacePath,
        '--actor', 'system',
        '--json',
      ]);
      expect(enable.ok).toBe(true);

      const evaluateOne = runCli([
        'trigger', 'evaluate', triggerPath,
        '-w', workspacePath,
        '--actor', 'system',
        '--json',
      ]);
      expect(evaluateOne.ok).toBe(true);

      const fire = runCli([
        'trigger', 'fire', triggerPath,
        '-w', workspacePath,
        '--actor', 'system',
        '--event-key', 'cli-manual-evt-1',
        '--json',
      ]);
      expect(fire.ok).toBe(true);
      const runId = String((fire.data as { run: { id: string } }).run.id);
      expect(runId.length > 0).toBe(true);

      const history = runCli([
        'trigger', 'history', triggerPath,
        '-w', workspacePath,
        '--json',
      ]);
      expect(history.ok).toBe(true);
      expect(((history.data as { count: number }).count) > 0).toBe(true);

      const update = runCli([
        'trigger', 'update', triggerPath,
        '-w', workspacePath,
        '--actor', 'system',
        '--type', 'event',
        '--condition', '{"type":"event","pattern":"thread.*"}',
        '--enabled', 'true',
        '--json',
      ]);
      expect(update.ok).toBe(true);
      expect((update.data as { trigger: { fields: { type: string } } }).trigger.fields.type).toBe('event');

      const remove = runCli([
        'trigger', 'delete', triggerPath,
        '-w', workspacePath,
        '--actor', 'system',
        '--json',
      ]);
      expect(remove.ok).toBe(true);
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
