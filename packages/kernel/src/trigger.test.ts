import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ledger from './ledger.js';
import { loadRegistry, saveRegistry } from './registry.js';
import * as store from './store.js';
import {
  createTrigger,
  deleteTrigger,
  disableTrigger,
  enableTrigger,
  fireTrigger,
  listTriggers,
  showTrigger,
  triggerHistory,
  updateTrigger,
} from './trigger.js';

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
  it('supports trigger primitive CRUD and state transitions', () => {
    const created = createTrigger(workspacePath, {
      actor: 'system',
      name: 'Nightly digest',
      type: 'cron',
      condition: '0 2 * * *',
      action: {
        type: 'dispatch-run',
        objective: 'Run nightly digest',
      },
      cooldown: 120,
      tags: ['ops', 'nightly'],
    });
    expect(created.path).toContain('triggers/');
    expect(String(created.fields.name)).toBe('Nightly digest');
    expect(String(created.fields.type)).toBe('cron');
    expect(created.fields.enabled).toBe(true);

    const listed = listTriggers(workspacePath, { type: 'cron', enabled: true });
    expect(listed.map((entry) => entry.path)).toContain(created.path);

    const shown = showTrigger(workspacePath, 'nightly-digest');
    expect(shown.path).toBe(created.path);

    const updated = updateTrigger(workspacePath, created.path, {
      actor: 'system',
      cooldown: 300,
      tags: ['ops', 'digest'],
    });
    expect(updated.fields.cooldown).toBe(300);
    expect(updated.fields.tags).toEqual(['ops', 'digest']);

    const disabled = disableTrigger(workspacePath, created.path, 'system');
    expect(disabled.fields.enabled).toBe(false);
    expect(disabled.fields.status).toBe('paused');

    const enabled = enableTrigger(workspacePath, created.path, 'system');
    expect(enabled.fields.enabled).toBe(true);
    expect(enabled.fields.status).toBe('active');

    const history = triggerHistory(workspacePath, created.path);
    expect(history.length).toBeGreaterThan(0);

    deleteTrigger(workspacePath, created.path, 'system');
    expect(listTriggers(workspacePath).some((entry) => entry.path === created.path)).toBe(false);
  });

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

  it('blocks manual fire when trigger is explicitly disabled', () => {
    const triggerPrimitive = store.create(
      workspacePath,
      'trigger',
      {
        title: 'Disabled trigger',
        type: 'manual',
        enabled: false,
        status: 'active',
        action: {
          type: 'dispatch-run',
          objective: 'Should never run',
        },
      },
      '# Trigger\n',
      'system',
    );

    expect(() => fireTrigger(workspacePath, triggerPrimitive.path, { actor: 'agent-x', eventKey: 'evt-1' }))
      .toThrow(`Trigger must be enabled to fire: ${triggerPrimitive.path}`);
  });

  it('fires using dispatch template interpolation and updates last_fired', () => {
    const triggerPrimitive = createTrigger(workspacePath, {
      actor: 'system',
      name: 'Escalate incident',
      type: 'manual',
      condition: { type: 'manual' },
      action: {
        type: 'dispatch-run',
        objective: 'Escalate {{incident_id}} to {{owner}}',
        context: {
          severity: '{{severity}}',
          incident_id: '{{incident_id}}',
        },
      },
    });

    const fired = fireTrigger(workspacePath, triggerPrimitive.path, {
      actor: 'agent-gate',
      eventKey: 'evt-manual-1',
      context: {
        incident_id: 'inc-17',
        owner: 'agent-ops',
        severity: 'critical',
      },
    });
    expect(fired.run.objective).toBe('Escalate inc-17 to agent-ops');
    expect(fired.run.context?.severity).toBe('critical');
    expect(fired.run.context?.incident_id).toBe('inc-17');
    expect(fired.run.context?.trigger_type).toBe('manual');

    const refreshed = showTrigger(workspacePath, triggerPrimitive.path);
    expect(typeof refreshed.fields.last_fired).toBe('string');
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
