import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadRegistry, saveRegistry } from './registry.js';
import { createThread, claim, done, block } from './thread.js';
import { generateCommandCenter } from './command-center.js';
import { readAll } from './ledger.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-command-center-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('command-center', () => {
  it('generates a markdown operational snapshot with thread and claim state', () => {
    createThread(workspacePath, 'Open task', 'open', 'agent-lead');
    createThread(workspacePath, 'Active task', 'active', 'agent-lead');
    claim(workspacePath, 'threads/active-task.md', 'agent-worker');

    createThread(workspacePath, 'Blocked task', 'blocked', 'agent-lead');
    claim(workspacePath, 'threads/blocked-task.md', 'agent-worker');
    block(workspacePath, 'threads/blocked-task.md', 'agent-worker', 'external/api', 'waiting');

    createThread(workspacePath, 'Done task', 'done', 'agent-lead');
    claim(workspacePath, 'threads/done-task.md', 'agent-worker');
    done(workspacePath, 'threads/done-task.md', 'agent-worker', 'complete');

    const result = generateCommandCenter(workspacePath, {
      actor: 'agent-observer',
      outputPath: 'ops/Command Center.md',
      recentCount: 10,
    });

    const absOutputPath = path.join(workspacePath, 'ops/Command Center.md');
    expect(fs.existsSync(absOutputPath)).toBe(true);
    expect(result.outputPath).toBe('ops/Command Center.md');
    expect(result.stats.totalThreads).toBe(4);
    expect(result.stats.openThreads).toBe(1);
    expect(result.stats.activeThreads).toBe(1);
    expect(result.stats.blockedThreads).toBe(1);
    expect(result.stats.doneThreads).toBe(1);

    const content = fs.readFileSync(absOutputPath, 'utf-8');
    expect(content).toContain('# Workgraph Command Center');
    expect(content).toContain('## Open Threads');
    expect(content).toContain('## Active Claims');
    expect(content).toContain('## Recent Ledger Activity');
    expect(content).toContain('Open task');

    const entries = readAll(workspacePath);
    const ccEntries = entries.filter((entry) => entry.type === 'command-center');
    expect(ccEntries).toHaveLength(1);
    expect(ccEntries[0].target).toBe('ops/Command Center.md');
  });

  it('rejects output paths outside of workspace', () => {
    expect(() => generateCommandCenter(workspacePath, { outputPath: '../outside.md' }))
      .toThrow('Invalid command-center output path');
  });
});
