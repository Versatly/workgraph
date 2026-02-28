import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import * as store from './store.js';
import * as thread from './thread.js';
import * as autonomy from './autonomy.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-autonomy-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('autonomy loop', () => {
  it('runs long-running collaboration cycles without leaving ready work behind', async () => {
    const a = thread.createThread(workspacePath, 'Task A', 'first', 'lead', { priority: 'high' });
    const b = thread.createThread(workspacePath, 'Task B', 'second', 'lead', { deps: [a.path], priority: 'medium' });
    const c = thread.createThread(workspacePath, 'Task C', 'third', 'lead', { deps: [b.path], priority: 'low' });

    const result = await autonomy.runAutonomyLoop(workspacePath, {
      actor: 'autonomy-lead',
      agents: ['auto-1', 'auto-2'],
      watch: false,
      maxCycles: 10,
      maxIdleCycles: 1,
      pollMs: 1,
      maxSteps: 100,
      stepDelayMs: 0,
      staleClaimMinutes: 30,
      executeTriggers: true,
      executeReadyThreads: true,
    });

    expect(result.finalReadyThreads).toBe(0);
    expect(result.finalDriftOk).toBe(true);
    expect(store.read(workspacePath, a.path)?.fields.status).toBe('done');
    expect(store.read(workspacePath, b.path)?.fields.status).toBe('done');
    expect(store.read(workspacePath, c.path)?.fields.status).toBe('done');
    expect(result.cycles.length).toBeGreaterThanOrEqual(1);
  });
});
