import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadRegistry, saveRegistry } from './registry.js';
import * as store from './store.js';
import * as policy from './policy.js';
import * as dispatch from './dispatch.js';
import * as ledger from './ledger.js';
import * as trigger from './trigger.js';
import * as thread from './thread.js';

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
    expect(followed.status).toBe('queued');
    expect(followed.followups).toHaveLength(1);

    const stopped = dispatch.stop(workspacePath, created.id, 'agent-operator');
    expect(stopped.status).toBe('cancelled');
    expect(dispatch.logs(workspacePath, created.id).length).toBeGreaterThanOrEqual(2);
  });

  it('supports marking runs as succeeded and failed', () => {
    const created = dispatch.createRun(workspacePath, {
      actor: 'agent-runner',
      objective: 'Mark state transitions',
    });
    const running = dispatch.markRun(workspacePath, created.id, 'agent-runner', 'running');
    expect(running.status).toBe('running');

    const succeeded = dispatch.markRun(workspacePath, created.id, 'agent-runner', 'succeeded', {
      output: 'All checks complete',
    });
    expect(succeeded.status).toBe('succeeded');
    expect(succeeded.output).toBe('All checks complete');

    const second = dispatch.createRun(workspacePath, {
      actor: 'agent-runner',
      objective: 'Failure flow',
    });
    dispatch.markRun(workspacePath, second.id, 'agent-runner', 'running');
    const failed = dispatch.markRun(workspacePath, second.id, 'agent-runner', 'failed', {
      error: 'runtime timeout',
    });
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('runtime timeout');
  });

  it('tracks run leases with heartbeat and requeues expired leases during reconcile', () => {
    const created = dispatch.createRun(workspacePath, {
      actor: 'agent-runner',
      objective: 'Lease lifecycle',
    });
    const running = dispatch.markRun(workspacePath, created.id, 'agent-runner', 'running');
    expect(running.leaseExpires).toBeDefined();
    expect(running.leaseDurationMinutes).toBe(30);

    const heartbeated = dispatch.heartbeat(workspacePath, created.id, {
      actor: 'agent-runner',
      leaseMinutes: 45,
    });
    expect(heartbeated.heartbeats).toHaveLength(1);
    expect(heartbeated.leaseDurationMinutes).toBe(45);
    expect(Date.parse(String(heartbeated.leaseExpires))).toBeGreaterThan(Date.now());

    const runPrimitive = store.list(workspacePath, 'run')
      .find((entry) => String(entry.fields.run_id) === created.id);
    expect(runPrimitive).toBeDefined();
    expect(runPrimitive?.fields.heartbeat_timestamps).toHaveLength(1);

    const dispatchStatePath = path.join(workspacePath, '.workgraph', 'dispatch-runs.json');
    const dispatchState = JSON.parse(fs.readFileSync(dispatchStatePath, 'utf-8')) as { version: number; runs: Array<Record<string, unknown>> };
    const idx = dispatchState.runs.findIndex((entry) => entry.id === created.id);
    dispatchState.runs[idx].leaseExpires = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(dispatchStatePath, JSON.stringify(dispatchState, null, 2) + '\n', 'utf-8');

    const reconciled = dispatch.reconcileExpiredLeases(workspacePath, 'agent-ops');
    expect(reconciled.requeuedRuns.map((run) => run.id)).toContain(created.id);
    const requeued = dispatch.status(workspacePath, created.id);
    expect(requeued.status).toBe('queued');
    expect(requeued.leaseExpires).toBeUndefined();
  });

  it('creates structured handoff runs and logs handoff entries', () => {
    const source = dispatch.createRun(workspacePath, {
      actor: 'agent-source',
      objective: 'Investigate production issue',
      context: {
        thread_slug: 'threads/prod-incident.md',
        incident_id: 'inc-123',
      },
    });

    const handoff = dispatch.handoffRun(workspacePath, source.id, {
      actor: 'agent-source',
      to: 'agent-specialist',
      reason: 'Needs database specialist',
    });

    expect(handoff.sourceRun.id).toBe(source.id);
    expect(handoff.handoffRun.id).not.toBe(source.id);
    expect(handoff.handoffRun.actor).toBe('agent-specialist');
    expect(handoff.handoffRun.objective).toBe(source.objective);
    expect(handoff.handoffRun.context?.thread_slug).toBe('threads/prod-incident.md');
    expect(handoff.handoffRun.context?.handoff_from_run_id).toBe(source.id);
    expect(handoff.handoffRun.context?.handoff_reason).toBe('Needs database specialist');

    const handoffEntries = ledger.readAll(workspacePath).filter((entry) => entry.op === 'handoff');
    expect(handoffEntries).toHaveLength(1);
    expect(handoffEntries[0].data?.from_run_id).toBe(source.id);
    expect(handoffEntries[0].data?.to_run_id).toBe(handoff.handoffRun.id);
  });

  it('rejects invalid run status transitions and followups after terminal state', () => {
    const created = dispatch.createRun(workspacePath, {
      actor: 'agent-runner',
      objective: 'Transition guard validation',
    });

    expect(() => dispatch.markRun(workspacePath, created.id, 'agent-runner', 'succeeded'))
      .toThrow(`Invalid run transition for ${created.id}: queued -> succeeded.`);

    dispatch.markRun(workspacePath, created.id, 'agent-runner', 'running');
    dispatch.markRun(workspacePath, created.id, 'agent-runner', 'cancelled');

    expect(() => dispatch.followup(workspacePath, created.id, 'agent-runner', 'post-cancel followup'))
      .toThrow(`Cannot send follow-up to run ${created.id} in terminal status "cancelled".`);
  });

  it('fires approved trigger and dispatches run with idempotency', () => {
    policy.upsertParty(workspacePath, 'agent-gate', {
      roles: ['reviewer'],
      capabilities: ['promote:sensitive'],
    });
    const trig = store.create(workspacePath, 'trigger', {
      title: 'Escalate blocked high-priority thread',
      event: 'thread.blocked',
      action: 'dispatch.review',
      status: 'draft',
    }, '# Trigger\n', 'agent-gate');
    store.update(workspacePath, trig.path, { status: 'approved' }, undefined, 'agent-gate');

    const fired1 = trigger.fireTrigger(workspacePath, trig.path, {
      actor: 'agent-gate',
      eventKey: 'evt-123',
    });
    const fired2 = trigger.fireTrigger(workspacePath, trig.path, {
      actor: 'agent-gate',
      eventKey: 'evt-123',
    });
    expect(fired1.run.id).toBe(fired2.run.id);

    const fired3 = trigger.fireTrigger(workspacePath, trig.path, {
      actor: 'agent-gate',
      eventKey: 'evt-124',
    });
    expect(fired3.run.id).not.toBe(fired1.run.id);
  });

  it('executes an autonomous multi-agent run and closes ready dependency chains', async () => {
    const a = thread.createThread(workspacePath, 'Build parser', 'Parser baseline', 'agent-lead', { priority: 'high' });
    const b = thread.createThread(workspacePath, 'Build validator', 'Validator baseline', 'agent-lead', { priority: 'high' });
    const c = thread.createThread(workspacePath, 'Wire parser+validator', 'Integrate parser and validator', 'agent-lead', {
      deps: [a.path, b.path],
      priority: 'medium',
    });
    const d = thread.createThread(workspacePath, 'Finalize release note', 'Prepare release note', 'agent-lead', {
      deps: [c.path],
      priority: 'low',
    });

    const queued = dispatch.createRun(workspacePath, {
      actor: 'agent-lead',
      objective: 'Autonomous execution test',
      adapter: 'cursor-cloud',
    });

    const finished = await dispatch.executeRun(workspacePath, queued.id, {
      actor: 'agent-lead',
      agents: ['agent-a', 'agent-b', 'agent-c'],
      maxSteps: 50,
      stepDelayMs: 0,
      createCheckpoint: true,
    });

    expect(finished.status).toBe('succeeded');
    expect(finished.output).toContain('Completed threads');
    expect(finished.logs.some((entry) => entry.message.includes('claimed'))).toBe(true);
    expect(dispatch.status(workspacePath, queued.id).status).toBe('succeeded');
    expect(store.read(workspacePath, a.path)?.fields.status).toBe('done');
    expect(store.read(workspacePath, b.path)?.fields.status).toBe('done');
    expect(store.read(workspacePath, c.path)?.fields.status).toBe('done');
    expect(store.read(workspacePath, d.path)?.fields.status).toBe('done');
  });
});
