import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  agentMatchesThreadRequirements,
  collectAgentCapabilityProfiles,
  listCapabilityRegistry,
  matchThreadToBestAgent,
  searchAgentsByCapability,
} from './capability.js';
import { loadRegistry, saveRegistry } from './registry.js';
import * as store from './store.js';
import * as thread from './thread.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-capability-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('capability registry', () => {
  it('collects capability profiles from agent and presence primitives', () => {
    seedAgent('agent-typescript', [
      { name: 'typescript', version: '5.4', confidence: 0.95 },
      'review',
    ]);
    seedPresence('agent-typescript', [
      { name: 'deploy', version: 'v2', confidence: 0.7 },
    ]);
    seedPresence('agent-review', ['review']);

    const profiles = collectAgentCapabilityProfiles(workspacePath);
    expect(profiles.map((profile) => profile.agent)).toEqual(['agent-review', 'agent-typescript']);
    const tsProfile = profiles.find((profile) => profile.agent === 'agent-typescript');
    expect(tsProfile?.capabilities.some((entry) => entry.name === 'typescript' && entry.version === '5.4')).toBe(true);
    expect(tsProfile?.capabilities.some((entry) => entry.name === 'review')).toBe(true);
    expect(tsProfile?.capabilities.some((entry) => entry.name === 'deploy')).toBe(true);
  });

  it('lists and searches capabilities by agent', () => {
    seedPresence('agent-a', ['typescript', { name: 'review', version: 'v1', confidence: 0.8 }]);
    seedPresence('agent-b', [{ name: 'typescript', version: '5.0', confidence: 0.9 }]);

    const registry = listCapabilityRegistry(workspacePath);
    expect(registry.map((entry) => entry.name)).toEqual(['review', 'typescript']);
    const ts = registry.find((entry) => entry.name === 'typescript');
    expect(ts?.agents.length).toBe(2);

    const search = searchAgentsByCapability(workspacePath, 'typescript');
    expect(search.query).toBe('typescript');
    expect(search.matches.map((entry) => entry.agent)).toEqual(['agent-a', 'agent-b']);
  });

  it('matches threads to best candidate agent by capability coverage', () => {
    seedPresence('agent-ts', [{ name: 'typescript', version: '5.*', confidence: 0.9 }]);
    seedPresence('agent-fullstack', [
      { name: 'typescript', version: '5.4', confidence: 0.97 },
      { name: 'review', version: '*', confidence: 0.85 },
    ]);
    seedPresence('agent-offline', [{ name: 'typescript', version: '5.4', confidence: 1 }], 'offline');

    const targetThread = thread.createThread(
      workspacePath,
      'Capability Match Target',
      'Find best candidate',
      'router',
    );
    store.update(
      workspacePath,
      targetThread.path,
      { required_capabilities: ['typescript', 'review'] },
      undefined,
      'system',
      { skipAuthorization: true },
    );

    const match = matchThreadToBestAgent(workspacePath, targetThread.path);
    expect(match.manualAssignmentRequired).toBe(false);
    expect(match.best?.agent).toBe('agent-fullstack');
    expect(match.best?.missingCapabilities).toEqual([]);

    const actorCheck = agentMatchesThreadRequirements(workspacePath, 'agent-ts', targetThread.path);
    expect(actorCheck.missingCapabilities.map((entry) => entry.name)).toEqual(['review']);
  });
});

function seedAgent(
  name: string,
  capabilities: Array<string | { name: string; version?: string; confidence?: number }>,
): void {
  store.create(
    workspacePath,
    'agent',
    {
      name,
      capabilities,
    },
    `# Agent ${name}`,
    'system',
    {
      skipAuthorization: true,
      pathOverride: `agents/profiles/${name}.md`,
    },
  );
}

function seedPresence(
  name: string,
  capabilities: Array<string | { name: string; version?: string; confidence?: number }>,
  status: 'online' | 'busy' | 'offline' = 'online',
): void {
  store.create(
    workspacePath,
    'presence',
    {
      name,
      status,
      capabilities,
      last_seen: new Date().toISOString(),
    },
    `# Presence ${name}`,
    'system',
    {
      skipAuthorization: true,
      pathOverride: `agents/presence/${name}.md`,
    },
  );
}
