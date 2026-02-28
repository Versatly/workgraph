import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import * as store from './store.js';
import * as thread from './thread.js';
import * as dispatch from './dispatch.js';
import {
  runReactiveSchedulerCycle,
  readReactiveSchedulerState,
  startReactiveScheduler,
} from './reactive-scheduler.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-reactive-scheduler-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('reactive scheduler', () => {
  it('auto-dispatches when a completed thread unlocks new ready work', async () => {
    const dep = thread.createThread(workspacePath, 'Dependency', 'Ship schema', 'lead');
    const followup = thread.createThread(workspacePath, 'Follow-up', 'Implement API', 'lead', {
      deps: [dep.path],
    });

    thread.claim(workspacePath, dep.path, 'worker-a');
    thread.done(workspacePath, dep.path, 'worker-a', 'Dependency done');

    const cycle = await runReactiveSchedulerCycle(workspacePath, {
      actor: 'scheduler-bot',
      stepDelayMs: 0,
      maxSteps: 50,
    });

    expect(cycle.completionEvents).toBeGreaterThan(0);
    expect(cycle.dispatches).toHaveLength(1);
    expect(dispatch.listRuns(workspacePath)).toHaveLength(1);
    expect(store.read(workspacePath, followup.path)?.fields.status).toBe('done');
  });

  it('does not dispatch without completion events', async () => {
    thread.createThread(workspacePath, 'Standalone', 'Do work', 'lead');

    const cycle = await runReactiveSchedulerCycle(workspacePath, {
      actor: 'scheduler-bot',
      stepDelayMs: 0,
    });

    expect(cycle.completionEvents).toBe(0);
    expect(cycle.dispatches).toHaveLength(0);
    expect(dispatch.listRuns(workspacePath)).toHaveLength(0);
  });

  it('does not dispatch when completion does not unlock new ready threads', async () => {
    const onlyThread = thread.createThread(workspacePath, 'Only', 'Single thread', 'lead');
    thread.claim(workspacePath, onlyThread.path, 'worker-a');
    thread.done(workspacePath, onlyThread.path, 'worker-a', 'all done');

    const cycle = await runReactiveSchedulerCycle(workspacePath, {
      actor: 'scheduler-bot',
      stepDelayMs: 0,
    });

    expect(cycle.completionEvents).toBe(1);
    expect(cycle.dispatches).toHaveLength(0);
    expect(dispatch.listRuns(workspacePath)).toHaveLength(0);
  });

  it('advances cursor state so previously processed events are not replayed', async () => {
    const dep = thread.createThread(workspacePath, 'Seed', 'seed', 'lead');
    const next = thread.createThread(workspacePath, 'Next', 'next', 'lead', { deps: [dep.path] });
    thread.claim(workspacePath, dep.path, 'worker-a');
    thread.done(workspacePath, dep.path, 'worker-a', 'done');

    const firstCycle = await runReactiveSchedulerCycle(workspacePath, {
      actor: 'scheduler-bot',
      stepDelayMs: 0,
      maxSteps: 50,
    });
    const secondCycle = await runReactiveSchedulerCycle(workspacePath, {
      actor: 'scheduler-bot',
      stepDelayMs: 0,
      maxSteps: 50,
    });

    expect(firstCycle.dispatches.length).toBe(1);
    expect(secondCycle.completionEvents).toBeGreaterThanOrEqual(0);
    expect(secondCycle.dispatches).toHaveLength(0);
    expect(store.read(workspacePath, next.path)?.fields.status).toBe('done');
    expect(readReactiveSchedulerState(workspacePath).dispatches).toBe(1);
  });

  it('supports space-scoped scheduling', async () => {
    const backendDep = thread.createThread(workspacePath, 'Backend Dep', 'backend', 'lead', {
      space: 'spaces/backend',
    });
    const backendNext = thread.createThread(workspacePath, 'Backend Next', 'backend next', 'lead', {
      deps: [backendDep.path],
      space: 'spaces/backend',
    });
    const frontendDep = thread.createThread(workspacePath, 'Frontend Dep', 'frontend', 'lead', {
      space: 'spaces/frontend',
    });
    const frontendNext = thread.createThread(workspacePath, 'Frontend Next', 'frontend next', 'lead', {
      deps: [frontendDep.path],
      space: 'spaces/frontend',
    });

    thread.claim(workspacePath, backendDep.path, 'worker-a');
    thread.done(workspacePath, backendDep.path, 'worker-a', 'backend done');

    const cycle = await runReactiveSchedulerCycle(workspacePath, {
      actor: 'scheduler-bot',
      stepDelayMs: 0,
      maxSteps: 50,
      space: 'spaces/backend',
    });

    expect(cycle.dispatches).toHaveLength(1);
    expect(store.read(workspacePath, backendNext.path)?.fields.status).toBe('done');
    expect(store.read(workspacePath, frontendNext.path)?.fields.status).toBe('open');
  });

  it('watches ledger updates and dispatches asynchronously while running', async () => {
    const dep = thread.createThread(workspacePath, 'Watched dependency', 'dep', 'lead');
    const next = thread.createThread(workspacePath, 'Watched next', 'next', 'lead', { deps: [dep.path] });
    const scheduler = startReactiveScheduler(workspacePath, {
      actor: 'scheduler-bot',
      pollMs: 20,
      stepDelayMs: 0,
      maxSteps: 50,
      runOnStart: false,
    });

    try {
      thread.claim(workspacePath, dep.path, 'worker-a');
      thread.done(workspacePath, dep.path, 'worker-a', 'done');

      await sleep(250);

      expect(store.read(workspacePath, next.path)?.fields.status).toBe('done');
      expect(dispatch.listRuns(workspacePath).length).toBeGreaterThanOrEqual(1);
      expect(scheduler.getLastCycle()).not.toBeNull();
    } finally {
      await scheduler.stop();
    }
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
