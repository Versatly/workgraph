import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  agent as agentModule,
  capability as capabilityModule,
  policy as policyModule,
  store as storeModule,
  thread as threadModule,
  workspace as workspaceModule,
} from '@versatly/workgraph-kernel';

const agent = agentModule;
const capability = capabilityModule;
const policy = policyModule;
const store = storeModule;
const thread = threadModule;
const workspace = workspaceModule;

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-stress-capability-matching-'));
  workspace.initWorkspace(workspacePath, { createReadme: false });
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('stress: capability matching at scale', () => {
  it('matches 50 agents against 100 threads under 100ms with accurate scoring', { timeout: 30_000 }, () => {
    const agentCount = 50;
    const threadCount = 100;
    const agentCapabilities = new Map<string, string[]>();

    for (let idx = 0; idx < agentCount; idx += 1) {
      const agentName = `agent-${idx}`;
      const capabilities = [
        `domain:team-${idx % 5}`,
        `dispatch:lane-${idx % 10}`,
        `skill:skill-${idx % 10}`,
        `adapter:adapter-${idx % 4}`,
      ];
      agentCapabilities.set(agentName, capabilities);
      policy.upsertParty(
        workspacePath,
        agentName,
        {
          roles: ['ops'],
          capabilities,
        },
        {
          actor: 'system',
          skipAuthorization: true,
        },
      );
      agent.heartbeat(workspacePath, agentName, {
        actor: 'system',
        capabilities,
      });
    }

    for (let idx = 0; idx < threadCount; idx += 1) {
      const sourceAgent = `agent-${idx % agentCount}`;
      const sourceCapabilities = agentCapabilities.get(sourceAgent) ?? [];
      const created = thread.createThread(
        workspacePath,
        `Capability thread ${idx}`,
        `Match capabilities for thread ${idx}.`,
        'system',
      );
      store.update(
        workspacePath,
        created.path,
        {
          required_capabilities: [sourceCapabilities[0], sourceCapabilities[1]],
          required_skills: [String(sourceCapabilities[2]).replace('skill:', '')],
          required_adapters: [String(sourceCapabilities[3]).replace('adapter:', '')],
        },
        undefined,
        'system',
      );
    }

    const capabilityRegistry = capability.buildAgentCapabilityRegistry(workspacePath);
    const threadInstances = store.list(workspacePath, 'thread');
    expect(capabilityRegistry.agents.length).toBeGreaterThanOrEqual(agentCount);
    const registryNames = new Set(capabilityRegistry.agents.map((entry) => entry.agentName));
    for (let idx = 0; idx < agentCount; idx += 1) {
      expect(registryNames.has(`agent-${idx}`)).toBe(true);
    }
    expect(threadInstances).toHaveLength(threadCount);

    for (const threadInstance of threadInstances.slice(0, 5)) {
      for (const profile of capabilityRegistry.agents.slice(0, 5)) {
        capability.matchThreadToCapabilityProfile(threadInstance, profile);
      }
    }

    const start = performance.now();
    let matchedPairs = 0;
    for (const threadInstance of threadInstances) {
      for (const profile of capabilityRegistry.agents) {
        const result = capability.matchThreadToCapabilityProfile(threadInstance, profile);
        if (result.matched) {
          matchedPairs += 1;
        }
      }
    }
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(100);
    expect(matchedPairs).toBeGreaterThan(0);

    const scoringThread = thread.createThread(
      workspacePath,
      'Scoring accuracy thread',
      'Validate capability scoring order.',
      'system',
    );
    store.update(
      workspacePath,
      scoringThread.path,
      {
        required_capabilities: ['domain:team-1', 'dispatch:lane-1'],
        required_skills: ['skill-1'],
        required_adapters: ['adapter-1'],
      },
      undefined,
      'system',
    );
    const updatedScoringThread = store.read(workspacePath, scoringThread.path);
    expect(updatedScoringThread).not.toBeNull();

    const agentPerfect = capabilityRegistry.agents.find((entry) => entry.agentName === 'agent-1');
    const agentPartial = capabilityRegistry.agents.find((entry) => entry.agentName === 'agent-11');
    const agentPoor = capabilityRegistry.agents.find((entry) => entry.agentName === 'agent-22');
    expect(agentPerfect).toBeDefined();
    expect(agentPartial).toBeDefined();
    expect(agentPoor).toBeDefined();

    const score = (candidate: ReturnType<typeof capability.matchThreadToCapabilityProfile>): number => {
      const totalMissing =
        candidate.missing.capabilities.length
        + candidate.missing.skills.length
        + candidate.missing.adapters.length;
      return 100 - totalMissing * 10;
    };

    const perfectMatch = capability.matchThreadToCapabilityProfile(updatedScoringThread!, agentPerfect!);
    const partialMatch = capability.matchThreadToCapabilityProfile(updatedScoringThread!, agentPartial!);
    const poorMatch = capability.matchThreadToCapabilityProfile(updatedScoringThread!, agentPoor!);

    expect(perfectMatch.matched).toBe(true);
    expect(partialMatch.matched).toBe(false);
    expect(poorMatch.matched).toBe(false);
    expect(score(perfectMatch)).toBeGreaterThan(score(partialMatch));
    expect(score(partialMatch)).toBeGreaterThanOrEqual(score(poorMatch));
  });
});
