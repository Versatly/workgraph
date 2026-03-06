import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as auth from './auth.js';
import * as agent from './agent.js';
import { assembleAgent } from './agent-self-assembly.js';
import * as conversation from './conversation.js';
import * as policy from './policy.js';
import * as store from './store.js';
import * as thread from './thread.js';
import { initWorkspace } from './workspace.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-agent-self-assembly-'));
  initWorkspace(workspacePath, { createReadme: false });
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('agent self-assembly', () => {
  it('runs auth -> discovery -> claim -> plan-step activation end-to-end', () => {
    const initResult = initWorkspace(workspacePath, { createReadme: false });
    const registration = agent.registerAgent(workspacePath, 'ops-agent', {
      token: initResult.bootstrapTrustToken,
      role: 'roles/ops.md',
      capabilities: ['thread:claim'],
    });
    expect(registration.apiKey).toBeDefined();

    const workThread = thread.createThread(
      workspacePath,
      'Investigate elevated error rate',
      'Locate root cause and propose remediation',
      'ops-agent',
    );
    const executionConversation = conversation.createConversation(
      workspacePath,
      'Ops execution',
      'ops-agent',
      { threadRefs: [workThread.path] },
    );
    const seededStep = conversation.createPlanStep(
      workspacePath,
      'Run first triage pass',
      'ops-agent',
      {
        conversationRef: executionConversation.conversation.path,
        threadRef: workThread.path,
      },
    );
    setStrictAuthMode(workspacePath);

    const result = assembleAgent(workspacePath, 'ops-agent', {
      credentialToken: registration.apiKey,
      advertise: {
        capabilities: ['domain:ops'],
        skills: ['incident-triage'],
        adapters: ['shell-worker'],
      },
    });

    expect(result.authenticated).toBe(true);
    expect(result.identityVerified).toBe(true);
    expect(result.claimedThread?.path).toBe(workThread.path);
    expect(result.planStep?.path).toBe(seededStep.path);
    expect(result.planStep?.fields.status).toBe('active');
    expect(String(result.planStep?.fields.assignee)).toBe('ops-agent');
    expect(String(result.claimedThread?.fields.status)).toBe('active');
    expect(result.brief.actor).toBe('ops-agent');
    expect(result.capabilityProfile.skills).toContain('incident-triage');
    expect(result.capabilityProfile.adapters).toContain('shell-worker');
    expect(result.warnings).toEqual([]);
  });

  it('matches advertised skills/adapters/capabilities to the right thread', () => {
    const initResult = initWorkspace(workspacePath, { createReadme: false });
    const registration = agent.registerAgent(workspacePath, 'router-agent', {
      token: initResult.bootstrapTrustToken,
      role: 'roles/ops.md',
      capabilities: ['thread:claim'],
    });
    expect(registration.apiKey).toBeDefined();

    const unmatchedThread = thread.createThread(
      workspacePath,
      'Requires code specialist',
      'Task requiring code-specialized profile',
      'router-agent',
      { priority: 'urgent' },
    );
    store.update(
      workspacePath,
      unmatchedThread.path,
      {
        required_skills: ['deep-typescript'],
        required_adapters: ['claude-code'],
      },
      undefined,
      'system',
    );

    const matchedThread = thread.createThread(
      workspacePath,
      'Requires ops triage',
      'Task requiring ops triage profile',
      'router-agent',
      { priority: 'high' },
    );
    store.update(
      workspacePath,
      matchedThread.path,
      {
        required_capabilities: ['domain:ops'],
        required_skills: ['incident-triage'],
        required_adapters: ['shell-worker'],
      },
      undefined,
      'system',
    );
    setStrictAuthMode(workspacePath);

    const result = assembleAgent(workspacePath, 'router-agent', {
      credentialToken: registration.apiKey,
      advertise: {
        capabilities: ['domain:ops'],
        skills: ['incident-triage'],
        adapters: ['shell-worker'],
      },
      createPlanStepIfMissing: false,
    });

    expect(result.claimedThread?.path).toBe(matchedThread.path);
    const unmatched = result.candidates.find((candidate) => candidate.thread.path === unmatchedThread.path);
    expect(unmatched).toBeDefined();
    expect(unmatched?.matched).toBe(false);
    expect(unmatched?.missing.skills).toContain('deep-typescript');
    expect(unmatched?.missing.adapters).toContain('claude-code');
  });

  it('recovers stale claims and lets another agent take over', () => {
    const initResult = initWorkspace(workspacePath, { createReadme: false });
    const firstAgent = agent.registerAgent(workspacePath, 'owner-agent', {
      token: initResult.bootstrapTrustToken,
      role: 'roles/ops.md',
      capabilities: ['thread:claim', 'policy:manage'],
    });
    expect(firstAgent.apiKey).toBeDefined();

    const leasedThread = thread.createThread(
      workspacePath,
      'Recoverable work item',
      'Must be reclaimed after stale lease',
      'owner-agent',
    );
    const takeoverAgent = provisionOpsCredential(workspacePath, 'takeover-agent');
    setStrictAuthMode(workspacePath);
    auth.runWithAuthContext({ credentialToken: firstAgent.apiKey, source: 'cli' }, () => {
      thread.claim(workspacePath, leasedThread.path, 'owner-agent', { leaseTtlMinutes: 0 });
    });

    const result = assembleAgent(workspacePath, 'takeover-agent', {
      credentialToken: takeoverAgent.apiKey,
      recoverStaleClaims: true,
      recoveryRequired: true,
      createPlanStepIfMissing: false,
    });

    expect(result.recovery?.reaped.map((entry) => entry.threadPath)).toContain(leasedThread.path);
    expect(result.claimedThread?.path).toBe(leasedThread.path);
    expect(String(result.claimedThread?.fields.owner)).toBe('takeover-agent');
  });
});

function setStrictAuthMode(targetWorkspacePath: string): void {
  const configPath = path.join(targetWorkspacePath, '.workgraph', 'server.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  config.auth = {
    mode: 'strict',
    allowUnauthenticatedFallback: false,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

function provisionOpsCredential(
  targetWorkspacePath: string,
  actor: string,
): auth.IssueAgentCredentialResult {
  const capabilities = ['thread:claim', 'thread:manage', 'dispatch:run', 'policy:manage', 'agent:register'];
  policy.upsertParty(targetWorkspacePath, actor, {
    roles: ['ops'],
    capabilities,
  }, {
    actor: 'system',
    skipAuthorization: true,
  });
  return auth.issueAgentCredential(targetWorkspacePath, {
    actor,
    scopes: capabilities,
    issuedBy: 'system',
  });
}
