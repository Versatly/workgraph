import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ledger from './ledger.js';
import { loadRegistry, saveRegistry } from './registry.js';
import * as store from './store.js';
import { fireTrigger } from './trigger.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-trigger-primitives-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('trigger primitives', () => {
  it('throws when trigger path does not exist', () => {
    expect(() => fireTrigger(workspacePath, 'triggers/missing-trigger.md', { actor: 'agent-x' }))
      .toThrow('Trigger not found: triggers/missing-trigger.md');
  });

  it('throws when target primitive is not a trigger', () => {
    const fact = store.create(
      workspacePath,
      'fact',
      {
        title: 'Fact target',
        subject: 'system',
        predicate: 'state',
        object: 'ok',
      },
      '# Fact\n',
      'agent-fact',
    );

    expect(() => fireTrigger(workspacePath, fact.path, { actor: 'agent-x' }))
      .toThrow(`Target is not a trigger primitive: ${fact.path}`);
  });

  it('requires trigger status to be approved or active', () => {
    const triggerPrimitive = store.create(
      workspacePath,
      'trigger',
      {
        title: 'Draft trigger',
        event: 'thread.blocked',
        action: 'dispatch.review',
        status: 'draft',
      },
      '# Trigger\n',
      'system',
    );

    expect(() => fireTrigger(workspacePath, triggerPrimitive.path, { actor: 'agent-x', eventKey: 'evt-1' }))
      .toThrow('Trigger must be approved/active to fire. Current status: draft');
  });

  it('fires active triggers with deterministic idempotency and writes ledger audit entries', () => {
    const triggerPrimitive = store.create(
      workspacePath,
      'trigger',
      {
        title: 'Escalate blocked thread',
        event: 'thread.blocked',
        action: 'dispatch.review',
        status: 'active',
      },
      '# Trigger\n',
      'system',
    );

    const first = fireTrigger(workspacePath, triggerPrimitive.path, {
      actor: 'agent-gate',
      eventKey: 'evt-100',
      context: {
        severity: 'high',
      },
    });
    const second = fireTrigger(workspacePath, triggerPrimitive.path, {
      actor: 'agent-gate',
      eventKey: 'evt-100',
      context: {
        severity: 'high',
      },
    });
    const third = fireTrigger(workspacePath, triggerPrimitive.path, {
      actor: 'agent-gate',
      eventKey: 'evt-101',
      context: {
        severity: 'high',
      },
    });
    const customObjective = fireTrigger(workspacePath, triggerPrimitive.path, {
      actor: 'agent-gate',
      eventKey: 'evt-100',
      objective: 'Escalate to incident commander',
      context: {
        severity: 'critical',
      },
    });

    expect(first.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.run.id).toBe(first.run.id);
    expect(third.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(third.run.id).not.toBe(first.run.id);
    expect(customObjective.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(customObjective.run.id).not.toBe(first.run.id);

    expect(first.run.context?.trigger_path).toBe(triggerPrimitive.path);
    expect(first.run.context?.trigger_event).toBe('thread.blocked');
    expect(first.run.context?.severity).toBe('high');
    expect(first.run.objective).toContain('Escalate blocked thread');
    expect(customObjective.run.objective).toBe('Escalate to incident commander');

    const triggerHistory = ledger.historyOf(workspacePath, triggerPrimitive.path)
      .filter((entry) => entry.data?.fired === true);
    expect(triggerHistory.length).toBe(4);
    expect(triggerHistory.at(-1)?.data?.run_id).toBe(customObjective.run.id);
    expect(triggerHistory.at(-1)?.data?.idempotency_key).toBe(customObjective.idempotencyKey);
  });
});
