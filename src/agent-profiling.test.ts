import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import * as thread from './thread.js';
import * as ledger from './ledger.js';
import { buildAgentProfiles, getAgentProfile } from './agent-profiling.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-agent-profiling-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('agent profiling', () => {
  it('computes completed tasks and average completion time from ledger events', async () => {
    const task = thread.createThread(workspacePath, 'Profiled task', 'finish me', 'lead');
    thread.claim(workspacePath, task.path, 'worker-a');
    await sleep(10);
    thread.done(workspacePath, task.path, 'worker-a', 'completed');

    const profile = getAgentProfile(workspacePath, 'worker-a');

    expect(profile.tasksCompleted).toBe(1);
    expect(profile.averageTaskDurationMs).toBeGreaterThan(0);
    expect(profile.averageTaskDurationMinutes).toBeGreaterThan(0);
    expect(profile.failureRate).toBe(0);
  });

  it('counts failed dispatch runs as failures', () => {
    ledger.append(workspacePath, 'worker-b', 'update', '.workgraph/runs/run-1', 'run', {
      status: 'failed',
    });

    const profile = getAgentProfile(workspacePath, 'worker-b');

    expect(profile.failures).toBe(1);
    expect(profile.attempts).toBe(1);
    expect(profile.failureRate).toBe(1);
  });

  it('counts thread cancellations as failures', () => {
    const task = thread.createThread(workspacePath, 'Cancelable', 'cancel me', 'lead');
    thread.claim(workspacePath, task.path, 'worker-c');
    thread.cancel(workspacePath, task.path, 'worker-c', 'could not finish');

    const profile = getAgentProfile(workspacePath, 'worker-c');

    expect(profile.tasksCompleted).toBe(0);
    expect(profile.failures).toBe(1);
    expect(profile.failureRate).toBe(1);
  });

  it('sorts profiles by completed tasks then failure rate', async () => {
    const a1 = thread.createThread(workspacePath, 'A1', 'one', 'lead');
    const b1 = thread.createThread(workspacePath, 'B1', 'one', 'lead');
    const b2 = thread.createThread(workspacePath, 'B2', 'two', 'lead');

    thread.claim(workspacePath, a1.path, 'worker-a');
    await sleep(5);
    thread.done(workspacePath, a1.path, 'worker-a', 'done');

    thread.claim(workspacePath, b1.path, 'worker-b');
    await sleep(5);
    thread.done(workspacePath, b1.path, 'worker-b', 'done');

    thread.claim(workspacePath, b2.path, 'worker-b');
    await sleep(5);
    thread.done(workspacePath, b2.path, 'worker-b', 'done');
    ledger.append(workspacePath, 'worker-b', 'update', '.workgraph/runs/run-2', 'run', {
      status: 'failed',
    });

    const snapshot = buildAgentProfiles(workspacePath);

    expect(snapshot.profiles[0]?.actor).toBe('worker-b');
    expect(snapshot.profiles[0]?.tasksCompleted).toBe(2);
    expect(snapshot.profiles[1]?.actor).toBe('worker-a');
  });

  it('returns an empty profile for actors with no ledger activity', () => {
    const profile = getAgentProfile(workspacePath, 'nobody');

    expect(profile.tasksCompleted).toBe(0);
    expect(profile.failures).toBe(0);
    expect(profile.attempts).toBe(0);
    expect(profile.lastActivityAt).toBeNull();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
