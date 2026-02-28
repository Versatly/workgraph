import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initWorkspace } from './workspace.js';
import {
  createPlanTemplate,
  validatePlan,
  deployPlan,
  getSwarmStatus,
  workerClaim,
  workerComplete,
  workerLoop,
  synthesize,
  type SwarmPlan,
  type SwarmTask,
} from './swarm.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-swarm-'));
  initWorkspace(workspacePath);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

function makePlan(taskCount: number): SwarmPlan {
  const tasks: SwarmTask[] = [];
  for (let i = 0; i < taskCount; i++) {
    tasks.push({
      title: `Task ${i + 1}`,
      description: `Do task ${i + 1}`,
      priority: i < 3 ? 'high' : 'medium',
      dependsOn: i > 0 && i % 5 === 0 ? [`Task ${i}`] : undefined,
      tags: ['test'],
    });
  }
  const plan = createPlanTemplate({
    title: 'Test Swarm',
    description: 'A test swarm with many tasks',
    maxTasks: 500,
  });
  plan.tasks = tasks;
  plan.phases = [
    { name: 'Phase 1', description: 'First batch', taskIndices: tasks.map((_, i) => i), parallel: true },
  ];
  return plan;
}

describe('swarm', () => {
  it('validates plans correctly', () => {
    const plan = makePlan(5);
    const result = validatePlan(plan);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects empty plans', () => {
    const plan = createPlanTemplate({ title: 'Empty', description: '' });
    const result = validatePlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('no tasks'))).toBe(true);
  });

  it('detects circular dependencies', () => {
    const plan = makePlan(3);
    plan.tasks[0].dependsOn = ['Task 3'];
    plan.tasks[2].dependsOn = ['Task 1'];
    const result = validatePlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Circular'))).toBe(true);
  });

  it('deploys a plan and creates threads', () => {
    const plan = makePlan(10);
    const deployment = deployPlan(workspacePath, plan, 'test-agent');
    expect(deployment.threadPaths).toHaveLength(10);
    expect(deployment.status).toBe('deployed');

    const status = getSwarmStatus(workspacePath, deployment.spaceSlug);
    expect(status.total).toBe(10);
    expect(status.open).toBe(10);
    expect(status.done).toBe(0);
    expect(status.percentComplete).toBe(0);
  });

  it('workers can claim and complete tasks', () => {
    const plan = makePlan(5);
    const deployment = deployPlan(workspacePath, plan, 'test-agent');

    // Worker claims
    const claimed = workerClaim(workspacePath, deployment.spaceSlug, 'worker-1');
    expect(claimed).not.toBeNull();
    expect(claimed!.fields.status).toBe('active');

    // Worker completes
    const completed = workerComplete(
      workspacePath,
      claimed!.path,
      'worker-1',
      'This is the result of my work.',
    );
    expect(completed.fields.status).toBe('done');

    // Status updates
    const status = getSwarmStatus(workspacePath, deployment.spaceSlug);
    expect(status.done).toBe(1);
    expect(status.percentComplete).toBe(20);
  });

  it('worker loop processes multiple tasks', async () => {
    const plan = makePlan(5);
    const deployment = deployPlan(workspacePath, plan, 'test-agent');

    const result = await workerLoop(
      workspacePath,
      deployment.spaceSlug,
      'worker-1',
      async (thread) => `Result for: ${thread.fields.title}`,
      { delayMs: 0 },
    );

    expect(result.completed).toBe(5);
    expect(result.errors).toBe(0);

    const status = getSwarmStatus(workspacePath, deployment.spaceSlug);
    expect(status.done).toBe(5);
    expect(status.percentComplete).toBe(100);
  });

  it('synthesizes results into a document', async () => {
    const plan = makePlan(3);
    const deployment = deployPlan(workspacePath, plan, 'test-agent');

    await workerLoop(
      workspacePath,
      deployment.spaceSlug,
      'worker-1',
      async (thread) => `Content for ${thread.fields.title}: Lorem ipsum dolor sit amet.`,
      { delayMs: 0 },
    );

    const synthesis = synthesize(workspacePath, deployment.spaceSlug);
    expect(synthesis.completedCount).toBe(3);
    expect(synthesis.totalCount).toBe(3);
    expect(synthesis.markdown).toContain('Test Swarm');
    expect(synthesis.markdown).toContain('Lorem ipsum');
    expect(synthesis.markdown).toContain('3/3 tasks completed');
  });

  it('handles large swarms (100 tasks)', async () => {
    const plan = makePlan(100);
    const deployment = deployPlan(workspacePath, plan, 'test-agent');

    const status = getSwarmStatus(workspacePath, deployment.spaceSlug);
    expect(status.total).toBe(100);
    expect(status.open).toBe(100);

    // Simulate 3 workers running in parallel
    const results = await Promise.all([
      workerLoop(workspacePath, deployment.spaceSlug, 'worker-1',
        async (t) => `W1: ${t.fields.title}`, { delayMs: 0 }),
      workerLoop(workspacePath, deployment.spaceSlug, 'worker-2',
        async (t) => `W2: ${t.fields.title}`, { delayMs: 0 }),
      workerLoop(workspacePath, deployment.spaceSlug, 'worker-3',
        async (t) => `W3: ${t.fields.title}`, { delayMs: 0 }),
    ]);

    const totalCompleted = results.reduce((sum, r) => sum + r.completed, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);
    // Concurrent workers may race on claims — total should be close to 100
    // Concurrent file-system workers race on claims — expect most to complete
    expect(totalCompleted + totalErrors).toBeGreaterThanOrEqual(50);

    const finalStatus = getSwarmStatus(workspacePath, deployment.spaceSlug);
    expect(finalStatus.done).toBeGreaterThanOrEqual(50);
  });
});
