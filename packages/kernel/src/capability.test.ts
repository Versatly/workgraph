import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as agent from './agent.js';
import {
  buildAgentCapabilityRegistry,
  matchThreadToAgent,
  matchThreadToCapabilityProfile,
  readThreadCapabilityRequirements,
  searchCapabilityRegistry,
} from './capability.js';
import * as policy from './policy.js';
import * as store from './store.js';
import * as thread from './thread.js';
import { initWorkspace } from './workspace.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-capability-'));
  initWorkspace(workspacePath, { createReadme: false });
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('capability registry and matching', () => {
  it('builds a merged agent capability registry from policy and presence', () => {
    policy.upsertParty(
      workspacePath,
      'ops-agent',
      {
        roles: ['ops'],
        capabilities: ['thread:claim', 'skill:incident-triage', 'adapter:shell-worker'],
      },
      {
        actor: 'system',
        skipAuthorization: true,
      },
    );
    agent.heartbeat(workspacePath, 'ops-agent', {
      actor: 'system',
      capabilities: ['domain:ops', 'skill:incident-triage'],
    });

    const registry = buildAgentCapabilityRegistry(workspacePath);
    const opsAgent = registry.agents.find((entry) => entry.agentName === 'ops-agent');

    expect(opsAgent).toBeDefined();
    expect(opsAgent?.capabilities).toEqual([
      'adapter:shell-worker',
      'domain:ops',
      'skill:incident-triage',
      'thread:claim',
    ]);
    expect(opsAgent?.skills).toEqual(['incident-triage']);
    expect(opsAgent?.adapters).toEqual(['shell-worker']);
    expect(opsAgent?.sources).toEqual(['policy', 'presence']);
    expect(registry.capabilities.find((entry) => entry.capability === 'domain:ops')?.agents).toEqual(['ops-agent']);
  });

  it('supports capability search by token or agent identifier', () => {
    policy.upsertParty(
      workspacePath,
      'router-agent',
      {
        roles: ['ops'],
        capabilities: ['dispatch:run', 'thread:claim'],
      },
      {
        actor: 'system',
        skipAuthorization: true,
      },
    );

    const dispatchMatches = searchCapabilityRegistry(workspacePath, 'dispatch');
    expect(dispatchMatches).toHaveLength(1);
    expect(dispatchMatches[0].capability).toBe('dispatch:run');
    expect(dispatchMatches[0].agents).toContain('router-agent');

    const agentMatches = searchCapabilityRegistry(workspacePath, 'router');
    expect(agentMatches.map((entry) => entry.capability)).toContain('dispatch:run');
    expect(agentMatches.map((entry) => entry.capability)).toContain('thread:claim');
  });

  it('reads thread requirements and computes missing capability dimensions', () => {
    const createdThread = thread.createThread(
      workspacePath,
      'Ops triage',
      'Perform triage using shell tooling',
      'system',
    );
    const updatedThread = store.update(
      workspacePath,
      createdThread.path,
      {
        required_capabilities: ['domain:ops'],
        required_skills: ['incident-triage'],
        required_adapters: ['shell-worker'],
        tags: [
          'requires:capability:dispatch:run',
          'requires:skill:postmortem-writing',
          'requires:adapter:cursor-cloud',
        ],
      },
      undefined,
      'system',
    );

    const requirements = readThreadCapabilityRequirements(updatedThread);
    expect(requirements.capabilities).toEqual(['domain:ops', 'dispatch:run']);
    expect(requirements.skills).toEqual(['incident-triage', 'postmortem-writing']);
    expect(requirements.adapters).toEqual(['shell-worker', 'cursor-cloud']);

    const matched = matchThreadToCapabilityProfile(updatedThread, {
      capabilities: [
        'domain:*',
        'dispatch:run',
        'skill:incident-triage',
        'skill:postmortem-writing',
        'adapter:shell-worker',
        'adapter:cursor-cloud',
      ],
    });
    expect(matched.matched).toBe(true);
    expect(matched.missing).toEqual({
      capabilities: [],
      skills: [],
      adapters: [],
    });

    const unmatched = matchThreadToCapabilityProfile(updatedThread, {
      capabilities: ['domain:ops'],
      skills: ['incident-triage'],
      adapters: ['shell-worker'],
    });
    expect(unmatched.matched).toBe(false);
    expect(unmatched.missing.capabilities).toEqual(['dispatch:run']);
    expect(unmatched.missing.skills).toEqual(['postmortem-writing']);
    expect(unmatched.missing.adapters).toEqual(['cursor-cloud']);
  });

  it('matches a thread to an agent profile resolved from registry', () => {
    policy.upsertParty(
      workspacePath,
      'router-agent',
      {
        roles: ['ops'],
        capabilities: ['domain:ops', 'dispatch:run', 'skill:incident-triage', 'adapter:shell-worker'],
      },
      {
        actor: 'system',
        skipAuthorization: true,
      },
    );
    agent.heartbeat(workspacePath, 'router-agent', {
      actor: 'system',
      capabilities: ['domain:ops', 'dispatch:run', 'skill:incident-triage', 'adapter:shell-worker'],
    });

    const createdThread = thread.createThread(
      workspacePath,
      'Route incident',
      'Dispatch and triage',
      'system',
    );
    store.update(
      workspacePath,
      createdThread.path,
      {
        required_capabilities: ['domain:ops', 'dispatch:run'],
        required_skills: ['incident-triage'],
        required_adapters: ['shell-worker'],
      },
      undefined,
      'system',
    );

    const match = matchThreadToAgent(workspacePath, 'route-incident', 'router-agent');
    expect(match.matched).toBe(true);
    expect(match.profile.agentName).toBe('router-agent');
    expect(match.profile.capabilities).toContain('dispatch:run');
  });
});
