import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as agent from './agent.js';
import {
  buildCapabilityRegistry,
  collectAgentCapabilities,
  matchThreadToAgents,
  searchCapabilities,
} from './capability.js';
import { loadRegistry, saveRegistry } from './registry.js';
import * as store from './store.js';
import { createThread } from './thread.js';

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
  it('collects and merges agent capabilities from frontmatter primitives', () => {
    store.create(
      workspacePath,
      'agent',
      {
        name: 'alpha',
        capabilities: ['dispatch:run', 'thread:claim'],
      },
      '',
      'agent-admin',
      {
        pathOverride: 'agents/alpha-profile.md',
      },
    );
    store.create(
      workspacePath,
      'presence',
      {
        name: 'alpha',
        status: 'busy',
        current_task: 'threads/incident-triage.md',
        last_seen: new Date().toISOString(),
        capabilities: ['thread:claim', 'thread:manage'],
      },
      '',
      'agent-admin',
      {
        pathOverride: 'agents/alpha-presence.md',
      },
    );
    store.create(
      workspacePath,
      'presence',
      {
        name: 'beta',
        status: 'online',
        last_seen: new Date().toISOString(),
        capabilities: ['thread:*'],
      },
      '',
      'agent-admin',
      {
        pathOverride: 'agents/beta-presence.md',
      },
    );

    const profiles = collectAgentCapabilities(workspacePath);
    const alphaProfile = profiles.find((profile) => profile.agentName === 'alpha');
    const betaProfile = profiles.find((profile) => profile.agentName === 'beta');

    expect(alphaProfile).toBeDefined();
    expect(alphaProfile?.capabilities).toEqual(['dispatch:run', 'thread:claim', 'thread:manage']);
    expect(alphaProfile?.status).toBe('busy');
    expect(alphaProfile?.currentTask).toBe('threads/incident-triage.md');
    expect(alphaProfile?.paths).toEqual(['agents/alpha-presence.md', 'agents/alpha-profile.md']);

    expect(betaProfile).toBeDefined();
    expect(betaProfile?.capabilities).toEqual(['thread:*']);
    expect(betaProfile?.status).toBe('online');
  });

  it('builds capability index entries by capability token', () => {
    agent.heartbeat(workspacePath, 'alpha', {
      actor: 'alpha',
      capabilities: ['thread:claim', 'dispatch:run'],
    });
    agent.heartbeat(workspacePath, 'beta', {
      actor: 'beta',
      capabilities: ['thread:claim'],
    });
    agent.heartbeat(workspacePath, 'gamma', {
      actor: 'gamma',
      capabilities: ['thread:manage'],
    });

    const registry = buildCapabilityRegistry(workspacePath);
    const threadClaimEntry = registry.capabilities.find((entry) => entry.capability === 'thread:claim');
    const dispatchEntry = registry.capabilities.find((entry) => entry.capability === 'dispatch:run');

    expect(registry.agents).toHaveLength(3);
    expect(threadClaimEntry).toEqual({
      capability: 'thread:claim',
      agents: ['alpha', 'beta'],
      count: 2,
    });
    expect(dispatchEntry?.agents).toEqual(['alpha']);
  });

  it('searches capability registry by capability token or agent name', () => {
    agent.heartbeat(workspacePath, 'alpha', {
      actor: 'alpha',
      capabilities: ['dispatch:run', 'thread:claim'],
    });
    agent.heartbeat(workspacePath, 'ops-bot', {
      actor: 'ops-bot',
      capabilities: ['incident:respond'],
    });

    const byCapability = searchCapabilities(workspacePath, 'dispatch');
    const byAgent = searchCapabilities(workspacePath, 'ops');

    expect(byCapability.capabilities.map((entry) => entry.capability)).toContain('dispatch:run');
    expect(byCapability.agents.map((profile) => profile.agentName)).toContain('alpha');
    expect(byAgent.agents.map((profile) => profile.agentName)).toContain('ops-bot');
  });
});

describe('thread capability matching', () => {
  it('matches thread requirements against agent capabilities with wildcard support', () => {
    agent.heartbeat(workspacePath, 'alpha', {
      actor: 'alpha',
      capabilities: ['thread:claim', 'dispatch:run', 'incident:respond'],
    });
    agent.heartbeat(workspacePath, 'beta', {
      actor: 'beta',
      capabilities: ['thread:*'],
    });
    agent.heartbeat(workspacePath, 'gamma', {
      actor: 'gamma',
      capabilities: ['*'],
    });

    createThread(workspacePath, 'Capability Fit', 'Route thread by capability requirements', 'agent-author');
    store.update(
      workspacePath,
      'threads/capability-fit.md',
      {
        required_capabilities: ['thread:claim', 'dispatch:run'],
        tags: ['requires:capability:incident:respond'],
      },
      undefined,
      'agent-author',
    );

    const result = matchThreadToAgents(workspacePath, 'capability-fit');
    const alpha = result.matches.find((entry) => entry.agent.agentName === 'alpha');
    const beta = result.matches.find((entry) => entry.agent.agentName === 'beta');
    const gamma = result.matches.find((entry) => entry.agent.agentName === 'gamma');

    expect(result.thread.path).toBe('threads/capability-fit.md');
    expect(result.requiredCapabilities).toEqual(['thread:claim', 'dispatch:run', 'incident:respond']);
    expect(alpha?.matched).toBe(true);
    expect(alpha?.missingCapabilities).toEqual([]);
    expect(beta?.matched).toBe(false);
    expect(beta?.missingCapabilities).toEqual(['dispatch:run', 'incident:respond']);
    expect(gamma?.matched).toBe(true);
    expect(gamma?.missingCapabilities).toEqual([]);
  });
});
