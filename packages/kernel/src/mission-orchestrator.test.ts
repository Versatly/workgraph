import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as dispatch from './dispatch.js';
import * as mission from './mission.js';
import * as missionOrchestrator from './mission-orchestrator.js';
import { loadRegistry, saveRegistry } from './registry.js';
import * as thread from './thread.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mission-orchestrator-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('mission orchestrator', () => {
  it('dispatches features, validates milestones, and completes mission sequentially', () => {
    const created = mission.createMission(
      workspacePath,
      'Launch payments service',
      'Ship payments service to production',
      'agent-pm',
    );
    mission.planMission(workspacePath, created.path, {
      milestones: [
        {
          id: 'ms-api',
          title: 'API readiness',
          features: ['Build API', 'Add auth'],
          validation: {
            strategy: 'automated',
            criteria: ['pnpm run test'],
          },
        },
        {
          id: 'ms-deploy',
          title: 'Deployment',
          deps: ['ms-api'],
          features: ['Deploy service'],
          validation: {
            strategy: 'manual',
            criteria: ['Smoke test endpoint'],
          },
        },
      ],
    }, 'agent-pm');
    mission.approveMission(workspacePath, created.path, 'agent-pm');
    mission.startMission(workspacePath, created.path, 'agent-pm');

    const firstCycle = missionOrchestrator.runMissionOrchestratorCycle(workspacePath, created.path);
    expect(firstCycle.dispatchedRuns.length).toBe(2);
    const allRunsAfterFirst = dispatch.listRuns(workspacePath);
    expect(allRunsAfterFirst.length).toBe(2);

    completeThread(workspacePath, 'threads/mission-launch-payments-service/build-api.md', 'agent-pm');
    completeThread(workspacePath, 'threads/mission-launch-payments-service/add-auth.md', 'agent-pm');

    const validationCycleOne = missionOrchestrator.runMissionOrchestratorCycle(workspacePath, created.path);
    expect(validationCycleOne.validationRunId).toBeDefined();
    const validationRunOneId = validationCycleOne.validationRunId!;
    dispatch.markRun(workspacePath, validationRunOneId, 'mission-orchestrator', 'running');
    dispatch.markRun(workspacePath, validationRunOneId, 'mission-orchestrator', 'succeeded');

    const passFirstMilestone = missionOrchestrator.runMissionOrchestratorCycle(workspacePath, created.path);
    expect(passFirstMilestone.actions.some((action) => action.startsWith('milestone-passed:ms-api'))).toBe(true);

    const dispatchSecondMilestone = missionOrchestrator.runMissionOrchestratorCycle(workspacePath, created.path);
    expect(dispatchSecondMilestone.dispatchedRuns.length).toBe(1);
    completeThread(workspacePath, 'threads/mission-launch-payments-service/deploy-service.md', 'agent-pm');

    const validationCycleTwo = missionOrchestrator.runMissionOrchestratorCycle(workspacePath, created.path);
    expect(validationCycleTwo.validationRunId).toBeDefined();
    dispatch.markRun(workspacePath, validationCycleTwo.validationRunId!, 'mission-orchestrator', 'running');
    dispatch.markRun(workspacePath, validationCycleTwo.validationRunId!, 'mission-orchestrator', 'succeeded');

    const completionCycle = missionOrchestrator.runMissionOrchestratorCycle(workspacePath, created.path);
    expect(completionCycle.missionStatus).toBe('completed');

    const finalMission = mission.missionStatus(workspacePath, created.path);
    expect(finalMission.fields.status).toBe('completed');
    const progress = mission.missionProgress(workspacePath, created.path);
    expect(progress.passedMilestones).toBe(2);
    expect(progress.doneFeatures).toBe(3);
  });
});

function completeThread(workspacePath: string, threadPath: string, actor: string): void {
  thread.claim(workspacePath, threadPath, actor);
  thread.done(
    workspacePath,
    threadPath,
    actor,
    `Completed ${threadPath} https://github.com/versatly/workgraph/pull/mission`,
  );
}
