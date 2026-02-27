import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadRegistry, saveRegistry } from './registry.js';
import * as store from './store.js';
import * as policy from './policy.js';
import * as dispatch from './dispatch.js';
import * as ledger from './ledger.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-policy-dispatch-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('policy gates and dispatch contract', () => {
  it('blocks sensitive promotion without policy capability and allows after grant', () => {
    const decision = store.create(workspacePath, 'decision', {
      title: 'Choose runtime',
      date: new Date().toISOString(),
      status: 'draft',
    }, '# Decision\n', 'agent-a');

    expect(() => store.update(workspacePath, decision.path, { status: 'approved' }, undefined, 'agent-a'))
      .toThrow('Policy gate blocked transition');

    policy.upsertParty(workspacePath, 'agent-a', {
      roles: ['reviewer'],
      capabilities: ['promote:sensitive'],
    });

    const approved = store.update(workspacePath, decision.path, { status: 'approved' }, undefined, 'agent-a');
    expect(approved.fields.status).toBe('approved');
  });

  it('blocks creating sensitive primitive directly in active state without capability', () => {
    expect(() => store.create(workspacePath, 'policy', {
      title: 'Direct active policy',
      status: 'active',
    }, '# policy\n', 'agent-plain')).toThrow('Policy gate blocked transition');

    policy.upsertParty(workspacePath, 'agent-plain', {
      roles: ['admin'],
      capabilities: ['promote:sensitive'],
    });
    const created = store.create(workspacePath, 'policy', {
      title: 'Direct active policy',
      status: 'active',
    }, '# policy\n', 'agent-plain');
    expect(created.fields.status).toBe('active');
  });

  it('adds status transition audit metadata into ledger updates', () => {
    const incident = store.create(workspacePath, 'incident', {
      title: 'Service degradation',
      status: 'draft',
    }, '# incident\n', 'agent-x');
    policy.upsertParty(workspacePath, 'agent-x', {
      roles: ['reviewer'],
      capabilities: ['promote:sensitive'],
    });
    store.update(workspacePath, incident.path, { status: 'approved' }, undefined, 'agent-x');
    const entries = ledger.historyOf(workspacePath, incident.path);
    const updateEntry = entries.find((entry) => entry.op === 'update');
    expect(updateEntry?.data?.from_status).toBe('draft');
    expect(updateEntry?.data?.to_status).toBe('approved');
  });

  it('supports dispatch create/status/followup/stop/logs flow', () => {
    const created = dispatch.createRun(workspacePath, {
      actor: 'agent-runner',
      objective: 'Process backlog',
      idempotencyKey: 'abc-123',
    });
    expect(created.status).toBe('queued');

    const duplicate = dispatch.createRun(workspacePath, {
      actor: 'agent-runner',
      objective: 'Process backlog',
      idempotencyKey: 'abc-123',
    });
    expect(duplicate.id).toBe(created.id);

    const followed = dispatch.followup(workspacePath, created.id, 'agent-runner', 'Begin phase 1');
    expect(followed.status).toBe('running');
    expect(followed.followups).toHaveLength(1);

    const stopped = dispatch.stop(workspacePath, created.id, 'agent-operator');
    expect(stopped.status).toBe('cancelled');
    expect(dispatch.logs(workspacePath, created.id).length).toBeGreaterThanOrEqual(2);
  });
});
