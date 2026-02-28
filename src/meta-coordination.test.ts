import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace } from './workspace.js';
import * as store from './store.js';
import * as thread from './thread.js';
import {
  createPlanTemplate,
  deployPlan,
  type SwarmPlan,
  type SwarmTask,
} from './swarm.js';
import { restructureSwarm } from './meta-coordination.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-meta-coordination-'));
  initWorkspace(workspacePath);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('meta coordination', () => {
  it('creates unblock coordination threads for blocked swarm work', () => {
    const plan = makePlan(2, 'medium');
    const deployment = deployPlan(workspacePath, plan, 'lead');
    const blockedPath = deployment.threadPaths[0]!;
    thread.claim(workspacePath, blockedPath, 'worker-a');
    thread.block(workspacePath, blockedPath, 'worker-a', 'external/dependency');

    const result = restructureSwarm(workspacePath, deployment.spaceSlug, {
      actor: 'meta-bot',
    });
    const createAction = result.actions.find((action) => action.type === 'create-unblock-thread');

    expect(createAction).toBeDefined();
    const createdPath = (createAction as { createdThreadPath: string }).createdThreadPath;
    const created = store.read(workspacePath, createdPath);
    expect(created).not.toBeNull();
    expect(created?.fields.meta_kind).toBe('meta-unblock');
    expect(created?.fields.meta_target).toBe(blockedPath);
  });

  it('does not create duplicate unblock threads across repeated cycles', () => {
    const plan = makePlan(2, 'medium');
    const deployment = deployPlan(workspacePath, plan, 'lead');
    const blockedPath = deployment.threadPaths[0]!;
    thread.claim(workspacePath, blockedPath, 'worker-a');
    thread.block(workspacePath, blockedPath, 'worker-a', 'external/dependency');

    const first = restructureSwarm(workspacePath, deployment.spaceSlug, {
      actor: 'meta-bot',
    });
    const second = restructureSwarm(workspacePath, deployment.spaceSlug, {
      actor: 'meta-bot',
    });

    expect(first.actions.filter((action) => action.type === 'create-unblock-thread')).toHaveLength(1);
    expect(second.actions.filter((action) => action.type === 'create-unblock-thread')).toHaveLength(0);
  });

  it('reprioritizes ready low-priority tasks when swarm is near completion', () => {
    const plan = makePlan(4, 'low');
    const deployment = deployPlan(workspacePath, plan, 'lead');
    const toComplete = deployment.threadPaths.slice(0, 3);
    for (const threadPath of toComplete) {
      thread.claim(workspacePath, threadPath, 'worker-a');
      thread.done(workspacePath, threadPath, 'worker-a', 'done');
    }
    const remaining = deployment.threadPaths[3]!;
    store.update(workspacePath, remaining, { priority: 'low' }, undefined, 'lead');

    const result = restructureSwarm(workspacePath, deployment.spaceSlug, {
      actor: 'meta-bot',
      priorityBoostCompletionThreshold: 70,
    });

    expect(result.actions.some((action) =>
      action.type === 'reprioritize-thread' && action.threadPath === remaining
    )).toBe(true);
    expect(String(store.read(workspacePath, remaining)?.fields.priority)).toBe('high');
  });

  it('does not reprioritize when completion threshold is not met', () => {
    const plan = makePlan(4, 'low');
    const deployment = deployPlan(workspacePath, plan, 'lead');
    thread.claim(workspacePath, deployment.threadPaths[0]!, 'worker-a');
    thread.done(workspacePath, deployment.threadPaths[0]!, 'worker-a', 'done');

    const candidate = deployment.threadPaths[1]!;
    store.update(workspacePath, candidate, { priority: 'low' }, undefined, 'lead');
    const result = restructureSwarm(workspacePath, deployment.spaceSlug, {
      actor: 'meta-bot',
      priorityBoostCompletionThreshold: 80,
    });

    expect(result.actions.filter((action) => action.type === 'reprioritize-thread')).toHaveLength(0);
    expect(String(store.read(workspacePath, candidate)?.fields.priority)).toBe('low');
  });

  it('can create unblock and reprioritize actions in one pass', () => {
    const plan = makePlan(5, 'low');
    const deployment = deployPlan(workspacePath, plan, 'lead');

    const blockedPath = deployment.threadPaths[0]!;
    thread.claim(workspacePath, blockedPath, 'worker-a');
    thread.block(workspacePath, blockedPath, 'worker-a', 'external/missing-input');

    for (const threadPath of deployment.threadPaths.slice(1, 4)) {
      thread.claim(workspacePath, threadPath, 'worker-a');
      thread.done(workspacePath, threadPath, 'worker-a', 'done');
    }
    const remainingReady = deployment.threadPaths[4]!;
    store.update(workspacePath, remainingReady, { priority: 'low' }, undefined, 'lead');

    const result = restructureSwarm(workspacePath, deployment.spaceSlug, {
      actor: 'meta-bot',
      priorityBoostCompletionThreshold: 50,
    });

    expect(result.actions.some((action) => action.type === 'create-unblock-thread')).toBe(true);
    expect(result.actions.some((action) => action.type === 'reprioritize-thread')).toBe(true);
  });
});

function makePlan(taskCount: number, priority: SwarmTask['priority']): SwarmPlan {
  const plan = createPlanTemplate({
    title: `Meta Plan ${taskCount}`,
    description: 'Meta coordination plan',
    maxTasks: 20,
  });
  plan.tasks = Array.from({ length: taskCount }, (_, idx) => ({
    title: `Task ${idx + 1}`,
    description: `Do task ${idx + 1}`,
    priority,
  }));
  plan.phases = [
    {
      name: 'Phase 1',
      description: 'All tasks',
      taskIndices: plan.tasks.map((_, idx) => idx),
      parallel: true,
    },
  ];
  return plan;
}
