import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as registry from './registry.js';
import * as store from './store.js';
import * as thread from './thread.js';
import * as dispatch from './dispatch.js';
import * as gate from './gate.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-gates-'));
  registry.saveRegistry(workspacePath, registry.loadRegistry(workspacePath));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('quality gates', () => {
  it('evaluates required facts, approvals, and minimum age', () => {
    const policyGate = store.create(workspacePath, 'policy-gate', {
      title: 'Readiness gate',
      status: 'active',
      required_facts: ['facts/release-signoff.md'],
      required_approvals: ['qa-lead'],
      min_age_seconds: 60,
    }, '# Gate\n', 'agent-policy');

    const createdThread = thread.createThread(
      workspacePath,
      'Release candidate',
      'Prepare RC for deployment',
      'agent-dev',
      {
        tags: ['release'],
      },
    );
    store.update(
      workspacePath,
      createdThread.path,
      {
        gates: [policyGate.path],
      },
      undefined,
      'agent-dev',
    );

    const blockedCheck = gate.checkThreadGates(workspacePath, createdThread.path);
    expect(blockedCheck.allowed).toBe(false);
    expect(blockedCheck.gates).toHaveLength(1);
    expect(blockedCheck.gates[0]?.rules.some((rule) => !rule.ok && rule.rule === 'required-facts')).toBe(true);
    expect(blockedCheck.gates[0]?.rules.some((rule) => !rule.ok && rule.rule === 'required-approvals')).toBe(true);
    expect(blockedCheck.gates[0]?.rules.some((rule) => !rule.ok && rule.rule === 'min-age-seconds')).toBe(true);

    store.create(
      workspacePath,
      'fact',
      {
        title: 'Release signoff',
        subject: 'release',
        predicate: 'approved-by',
        object: 'qa',
      },
      '# Fact\n',
      'agent-policy',
      { pathOverride: 'facts/release-signoff.md' },
    );
    store.update(
      workspacePath,
      createdThread.path,
      {
        approvals: ['qa-lead'],
        created: new Date(Date.now() - 120_000).toISOString(),
      },
      undefined,
      'agent-dev',
    );

    const passedCheck = gate.checkThreadGates(workspacePath, createdThread.path);
    expect(passedCheck.allowed).toBe(true);
    expect(passedCheck.gates[0]?.rules.every((rule) => rule.ok)).toBe(true);
  });

  it('blocks dispatch claim until gate checks pass', () => {
    const policyGate = store.create(workspacePath, 'policy-gate', {
      title: 'Approval gate',
      status: 'active',
      required_approvals: ['security'],
    }, '# Gate\n', 'agent-policy');

    const createdThread = thread.createThread(
      workspacePath,
      'Ship security fix',
      'Deploy patch safely',
      'agent-dev',
    );
    store.update(
      workspacePath,
      createdThread.path,
      {
        gates: [policyGate.path],
      },
      undefined,
      'agent-dev',
    );

    expect(() => dispatch.claimThread(workspacePath, createdThread.path, 'agent-worker'))
      .toThrow('Quality gates blocked claim');

    store.update(
      workspacePath,
      createdThread.path,
      {
        approvals: ['security'],
      },
      undefined,
      'agent-dev',
    );
    const claimed = dispatch.claimThread(workspacePath, createdThread.path, 'agent-worker');
    expect(claimed.thread.fields.status).toBe('active');
    expect(claimed.thread.fields.owner).toBe('agent-worker');
    expect(claimed.gateCheck.allowed).toBe(true);
  });
});
