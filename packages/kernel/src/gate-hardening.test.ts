import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as gate from './gate.js';
import * as registry from './registry.js';
import * as store from './store.js';
import * as thread from './thread.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-gate-hardening-'));
  registry.saveRegistry(workspacePath, registry.loadRegistry(workspacePath));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('gate hardening', () => {
  it('defaults evidence policy to strict when no gate is configured', () => {
    const task = thread.createThread(workspacePath, 'No gate policy', 'default strict', 'agent-a');
    expect(gate.resolveThreadEvidencePolicy(workspacePath, task.path)).toBe('strict');
  });

  it('resolves strict evidence policy precedence over relaxed and none', () => {
    const noneGate = store.create(workspacePath, 'policy-gate', {
      title: 'None policy',
      status: 'active',
      evidencePolicy: 'none',
    }, '# Gate', 'agent-policy');
    const relaxedGate = store.create(workspacePath, 'policy-gate', {
      title: 'Relaxed policy',
      status: 'active',
      evidencePolicy: 'relaxed',
    }, '# Gate', 'agent-policy');
    const strictGate = store.create(workspacePath, 'policy-gate', {
      title: 'Strict policy',
      status: 'active',
      evidencePolicy: 'strict',
    }, '# Gate', 'agent-policy');
    const task = thread.createThread(workspacePath, 'Precedence task', 'check precedence', 'agent-a');
    store.update(workspacePath, task.path, { gates: [noneGate.path, relaxedGate.path, strictGate.path] }, undefined, 'agent-a');

    expect(gate.resolveThreadEvidencePolicy(workspacePath, task.path)).toBe('strict');
  });

  it('reports no unresolved descendants when a thread has no children', () => {
    const task = thread.createThread(workspacePath, 'Standalone', 'no children', 'agent-a');
    const result = gate.checkRequiredDescendants(workspacePath, task.path);
    expect(result.ok).toBe(true);
    expect(result.unresolvedDescendants).toEqual([]);
  });

  it('returns recursive unresolved descendants for nested children', () => {
    const parent = thread.createThread(workspacePath, 'Parent', 'parent goal', 'agent-a');
    const [child] = thread.decompose(workspacePath, parent.path, [{ title: 'Child', goal: 'child goal' }], 'agent-a');
    thread.decompose(workspacePath, child.path, [{ title: 'Grandchild', goal: 'grandchild goal' }], 'agent-a');

    const result = gate.checkRequiredDescendants(workspacePath, parent.path);
    expect(result.ok).toBe(false);
    expect(result.unresolvedDescendants).toContain('threads/child.md');
    expect(result.unresolvedDescendants).toContain('threads/grandchild.md');
  });

  it('evaluates required-descendants gate rule and blocks when descendants are unresolved', () => {
    const parent = thread.createThread(workspacePath, 'Gate parent', 'parent goal', 'agent-a');
    thread.decompose(workspacePath, parent.path, [{ title: 'Gate child', goal: 'child goal' }], 'agent-a');
    const descGate = store.create(workspacePath, 'policy-gate', {
      title: 'Require descendants',
      status: 'active',
      requiredDescendants: true,
    }, '# Gate', 'agent-policy');
    store.update(workspacePath, parent.path, { gates: [descGate.path] }, undefined, 'agent-a');

    const result = gate.checkThreadGates(workspacePath, parent.path);
    expect(result.allowed).toBe(false);
    const descendantRule = result.gates[0]?.rules.find((rule) => rule.rule === 'required-descendants');
    expect(descendantRule?.ok).toBe(false);
    expect(descendantRule?.message).toContain('Unresolved descendants');
  });

  it('passes required-descendants gate rule once descendants are resolved', () => {
    const parent = thread.createThread(workspacePath, 'Resolved parent', 'parent goal', 'agent-a');
    const [child] = thread.decompose(workspacePath, parent.path, [{ title: 'Resolved child', goal: 'child goal' }], 'agent-a');
    const descGate = store.create(workspacePath, 'policy-gate', {
      title: 'Require descendants',
      status: 'active',
      requiredDescendants: true,
    }, '# Gate', 'agent-policy');
    store.update(workspacePath, parent.path, { gates: [descGate.path] }, undefined, 'agent-a');
    thread.claim(workspacePath, child.path, 'agent-a');
    thread.done(workspacePath, child.path, 'agent-a', 'proof https://github.com/versatly/workgraph/pull/51');

    const result = gate.checkThreadGates(workspacePath, parent.path);
    expect(result.allowed).toBe(true);
  });

  it('does not enforce descendant completion when requiredDescendants is false', () => {
    const parent = thread.createThread(workspacePath, 'Optional descendants parent', 'parent goal', 'agent-a');
    thread.decompose(workspacePath, parent.path, [{ title: 'Optional child', goal: 'child goal' }], 'agent-a');
    const optionalGate = store.create(workspacePath, 'policy-gate', {
      title: 'Optional descendants',
      status: 'active',
      requiredDescendants: false,
    }, '# Gate', 'agent-policy');
    store.update(workspacePath, parent.path, { gates: [optionalGate.path] }, undefined, 'agent-a');

    const result = gate.checkThreadGates(workspacePath, parent.path);
    expect(result.allowed).toBe(true);
    const descendantRule = result.gates[0]?.rules.find((rule) => rule.rule === 'required-descendants');
    expect(descendantRule?.ok).toBe(true);
  });

  it('supports legacy required_descendants field alias', () => {
    const parent = thread.createThread(workspacePath, 'Legacy parent', 'parent goal', 'agent-a');
    thread.decompose(workspacePath, parent.path, [{ title: 'Legacy child', goal: 'child goal' }], 'agent-a');
    const legacyGate = store.create(workspacePath, 'policy-gate', {
      title: 'Legacy descendants gate',
      status: 'active',
      required_descendants: true,
    }, '# Gate', 'agent-policy');
    store.update(workspacePath, parent.path, { gates: [legacyGate.path] }, undefined, 'agent-a');

    const result = gate.checkThreadGates(workspacePath, parent.path);
    expect(result.allowed).toBe(false);
    expect(result.gates[0]?.rules.some((rule) => rule.rule === 'required-descendants' && !rule.ok)).toBe(true);
  });
});
