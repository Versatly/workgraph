import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as mission from './mission.js';
import { loadRegistry, saveRegistry } from './registry.js';
import * as store from './store.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mission-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('mission lifecycle', () => {
  it('creates, plans, approves, and starts a mission', () => {
    const created = mission.createMission(
      workspacePath,
      'Deploy cloud backend',
      'Ship backend to production',
      'agent-planner',
      {
        constraints: ['Use zero downtime deploys'],
        tags: ['deployment'],
      },
    );
    expect(created.path).toBe('missions/deploy-cloud-backend.md');
    expect(created.fields.status).toBe('planning');

    const planned = mission.planMission(workspacePath, created.path, {
      goal: 'Production-ready backend rollout',
      constraints: ['No downtime', 'Database migrations must be reversible'],
      estimated_runs: 6,
      milestones: [
        {
          id: 'ms-1',
          title: 'Core API',
          features: [
            'Database migrations',
            { title: 'Authentication hardening', goal: 'Harden authentication flows' },
          ],
          validation: {
            strategy: 'automated',
            criteria: ['pnpm run test', 'pnpm run build'],
          },
        },
        {
          id: 'ms-2',
          title: 'Deploy and monitor',
          deps: ['ms-1'],
          features: ['Production deployment'],
          validation: {
            strategy: 'manual',
            criteria: ['Smoke test production endpoint'],
          },
        },
      ],
    }, 'agent-planner');
    expect(Array.isArray(planned.fields.milestones)).toBe(true);
    expect((planned.fields.milestones as unknown[]).length).toBe(2);

    const missionInstance = store.read(workspacePath, created.path);
    expect(missionInstance).not.toBeNull();
    const milestones = missionInstance?.fields.milestones as Array<{ features: string[] }>;
    expect(milestones[0]?.features.length).toBe(2);
    expect(milestones[1]?.features.length).toBe(1);

    const featureThreads = store.list(workspacePath, 'thread');
    expect(featureThreads.length).toBe(3);
    for (const featureThread of featureThreads) {
      expect(String(featureThread.fields.parent)).toBe(created.path);
      expect(featureThread.path.startsWith('threads/mission-deploy-cloud-backend/')).toBe(true);
    }

    const approved = mission.approveMission(workspacePath, created.path, 'agent-planner');
    expect(approved.fields.status).toBe('approved');

    const started = mission.startMission(workspacePath, created.path, 'agent-planner');
    expect(started.fields.status).toBe('active');
    const startedMilestones = started.fields.milestones as Array<{ id: string; status: string }>;
    expect(startedMilestones.find((entry) => entry.id === 'ms-1')?.status).toBe('active');
  });

  it('reports mission progress and supports interventions', () => {
    const created = mission.createMission(
      workspacePath,
      'Release app v2',
      'Ship v2 safely',
      'agent-release',
    );
    mission.planMission(workspacePath, created.path, {
      milestones: [
        {
          id: 'ms-core',
          title: 'Core',
          features: ['API', 'Auth'],
        },
      ],
    }, 'agent-release');

    const before = mission.missionProgress(workspacePath, created.path);
    expect(before.totalMilestones).toBe(1);
    expect(before.totalFeatures).toBe(2);
    expect(before.doneFeatures).toBe(0);

    const intervened = mission.interveneMission(workspacePath, created.path, {
      reason: 'Scope narrowed after incident review.',
      skipFeature: {
        milestoneId: 'ms-core',
        threadPath: 'threads/mission-release-app-v2/auth.md',
      },
      appendMilestones: [
        {
          id: 'ms-monitoring',
          title: 'Monitoring',
          deps: ['ms-core'],
          features: ['Dashboards'],
        },
      ],
      setPriority: 'high',
    }, 'agent-release');
    expect(intervened.fields.priority).toBe('high');

    const after = mission.missionProgress(workspacePath, created.path);
    expect(after.totalMilestones).toBe(2);
    expect(after.totalFeatures).toBe(2);
    const missionInstance = mission.missionStatus(workspacePath, created.path);
    const milestones = missionInstance.fields.milestones as Array<{ id: string; features: string[] }>;
    expect(milestones.find((entry) => entry.id === 'ms-core')?.features).toEqual([
      'threads/mission-release-app-v2/api.md',
    ]);
  });
});
