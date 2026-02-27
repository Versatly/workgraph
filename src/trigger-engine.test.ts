import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import * as policy from './policy.js';
import * as store from './store.js';
import * as thread from './thread.js';
import * as triggerEngine from './trigger-engine.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-trigger-engine-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('trigger engine', () => {
  it('processes ledger events with cursor persistence and idempotent trigger firing', async () => {
    policy.upsertParty(workspacePath, 'trigger-gate', {
      roles: ['reviewer'],
      capabilities: ['promote:sensitive'],
    });

    const triggerPrimitive = store.create(workspacePath, 'trigger', {
      title: 'Escalate blocked threads',
      event: 'thread.blocked',
      action: 'dispatch.review',
      status: 'draft',
    }, '# Trigger\n', 'trigger-gate');
    store.update(workspacePath, triggerPrimitive.path, { status: 'approved' }, undefined, 'trigger-gate');

    const blockedThread = thread.createThread(
      workspacePath,
      'Blocked integration task',
      'Wait for external dependency',
      'worker-a',
      { priority: 'high' },
    );
    thread.claim(workspacePath, blockedThread.path, 'worker-a');
    thread.block(workspacePath, blockedThread.path, 'worker-a', 'external/api', 'Dependency unavailable');

    const firstCycle = await triggerEngine.runTriggerEngineCycle(workspacePath, {
      actor: 'trigger-engine',
      executeRuns: false,
    });
    expect(firstCycle.actions).toHaveLength(1);
    expect(firstCycle.actions[0].eventName).toBe('thread.blocked');
    expect(firstCycle.actions[0].runStatus).toBe('queued');
    expect(firstCycle.state.lastProcessedIndex).toBeGreaterThanOrEqual(0);

    const secondCycle = await triggerEngine.runTriggerEngineCycle(workspacePath, {
      actor: 'trigger-engine',
      executeRuns: false,
    });
    expect(secondCycle.actions).toHaveLength(0);
    expect(secondCycle.matchedEvents).toBe(0);

    const loadedState = triggerEngine.loadTriggerEngineState(workspacePath);
    expect(loadedState.lastProcessedIndex).toBe(secondCycle.state.lastProcessedIndex);
  });
});
