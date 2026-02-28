import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as registry from './registry.js';
import * as store from './store.js';
import * as thread from './thread.js';
import * as triggerEngine from './trigger-engine.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-trigger-engine-'));
  registry.saveRegistry(workspacePath, registry.loadRegistry(workspacePath));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('trigger engine', () => {
  it.skip('executes update-primitive and shell trigger actions (flaky in CI)', () => {
    const targetFact = store.create(workspacePath, 'fact', {
      title: 'Target fact',
      subject: 'system',
      predicate: 'state',
      object: 'initial',
      tags: ['ops'],
    }, '# Fact\n', 'agent-fact', { pathOverride: 'facts/target-fact.md' });

    store.create(workspacePath, 'trigger', {
      title: 'Update target fact when facts change',
      status: 'active',
      condition: { type: 'file-watch', glob: 'facts/**/*.md' },
      action: {
        type: 'update-primitive',
        path: targetFact.path,
        fields: { object: 'updated-by-trigger' },
      },
      cooldown: 0,
    }, '# Trigger\n', 'system');

    store.create(workspacePath, 'trigger', {
      title: 'Emit shell marker when facts change',
      status: 'active',
      condition: { type: 'file-watch', glob: 'facts/**/*.md' },
      action: {
        type: 'shell',
        command: 'echo shell-fired > .workgraph/shell-trigger.txt',
      },
      cooldown: 0,
    }, '# Trigger\n', 'system');

    const initCycle = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    expect(initCycle.fired).toBe(0);

    store.create(workspacePath, 'fact', {
      title: 'Changed fact',
      subject: 'system',
      predicate: 'state',
      object: 'changed',
      tags: ['ops'],
    }, '# Fact\n', 'agent-fact', { pathOverride: 'facts/changed-fact.md' });

    const fireCycle = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    expect(fireCycle.fired).toBe(2);
    expect(store.read(workspacePath, targetFact.path)?.fields.object).toBe('updated-by-trigger');

    const shellMarker = path.join(workspacePath, '.workgraph', 'shell-trigger.txt');
    expect(fs.existsSync(shellMarker)).toBe(true);
    expect(fs.readFileSync(shellMarker, 'utf-8')).toContain('shell-fired');
  });

  it('evaluates active triggers, respects cooldown, and persists state', () => {
    const triggerPrimitive = store.create(workspacePath, 'trigger', {
      title: 'Follow-up on done threads',
      status: 'active',
      condition: { type: 'event', event: 'thread-complete' },
      action: {
        type: 'create-thread',
        title: 'Follow-up {{matched_event_latest_target}}',
        goal: 'Investigate completed work outputs',
        tags: ['follow-up'],
      },
      cooldown: 120,
    }, '# Trigger\n', 'system');

    const initCycle = triggerEngine.runTriggerEngineCycle(workspacePath, {
      actor: 'system',
    });
    expect(initCycle.fired).toBe(0);

    const seededThread = thread.createThread(workspacePath, 'Implement parser', 'Ship parser MVP', 'agent-dev');
    thread.claim(workspacePath, seededThread.path, 'agent-dev');
    thread.done(workspacePath, seededThread.path, 'agent-dev', 'Parser complete');

    const fireCycle = triggerEngine.runTriggerEngineCycle(workspacePath, {
      actor: 'system',
    });
    expect(fireCycle.fired).toBe(1);
    const createdThreads = store.list(workspacePath, 'thread');
    expect(createdThreads.some((entry) => String(entry.fields.title).startsWith('Follow-up'))).toBe(true);

    const cooldownCycle = triggerEngine.runTriggerEngineCycle(workspacePath, {
      actor: 'system',
    });
    expect(cooldownCycle.fired).toBe(0);
    const triggerResult = cooldownCycle.triggers.find((entry) => entry.triggerPath === triggerPrimitive.path);
    expect(triggerResult?.runtimeState).toBe('cooldown');

    const statePath = triggerEngine.triggerStatePath(workspacePath);
    expect(fs.existsSync(statePath)).toBe(true);
    const state = triggerEngine.loadTriggerState(workspacePath);
    expect(state.triggers[triggerPrimitive.path]?.fireCount).toBe(1);
    expect(state.triggers[triggerPrimitive.path]?.cooldownUntil).toBeDefined();
  });

  it('fires cascade triggers immediately when thread reaches done state', () => {
    const cascadeTrigger = store.create(workspacePath, 'trigger', {
      title: 'Cascade on completion',
      status: 'active',
      condition: { type: 'thread-complete' },
      cascade_on: ['thread-complete'],
      action: {
        type: 'create-thread',
        title: 'Cascade from {{completed_thread_path}}',
        goal: 'Run follow-up thread generated via cascade',
      },
      cooldown: 0,
    }, '# Trigger\n', 'system');

    const sourceThread = thread.createThread(workspacePath, 'Source thread', 'Complete source', 'agent-owner');
    thread.claim(workspacePath, sourceThread.path, 'agent-owner');
    thread.done(workspacePath, sourceThread.path, 'agent-owner', 'Source complete');

    const threads = store.list(workspacePath, 'thread');
    expect(threads).toHaveLength(2);
    expect(threads.some((entry) => String(entry.fields.title).startsWith('Cascade from'))).toBe(true);

    const state = triggerEngine.loadTriggerState(workspacePath);
    expect(state.triggers[cascadeTrigger.path]?.fireCount).toBe(1);
  });

  it('auto-synthesis trigger fires when threshold of new tagged facts is met', () => {
    const synthesis = triggerEngine.addSynthesisTrigger(workspacePath, {
      tagPattern: 'research-*',
      threshold: 2,
      actor: 'agent-synth',
    });

    const initCycle = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    expect(initCycle.fired).toBe(0);
    const initialState = triggerEngine.loadTriggerState(workspacePath);
    const cursorTs = initialState.triggers[synthesis.trigger.path]?.synthesisCursorTs;
    expect(cursorTs).toBeDefined();
    const cursorMs = Date.parse(String(cursorTs));

    const factA = store.create(workspacePath, 'fact', {
      title: 'Research A',
      subject: 'db',
      predicate: 'has',
      object: 'finding-a',
      tags: ['research-db'],
    }, '# Fact A\n', 'agent-fact', { pathOverride: 'facts/research-a.md' });
    store.update(
      workspacePath,
      factA.path,
      { created: new Date(cursorMs + 1_000).toISOString() },
      undefined,
      'agent-fact',
    );

    const underThresholdCycle = triggerEngine.runTriggerEngineCycle(workspacePath, {
      actor: 'system',
      now: new Date(cursorMs + 1_500),
    });
    expect(underThresholdCycle.fired).toBe(0);

    const factB = store.create(workspacePath, 'fact', {
      title: 'Research B',
      subject: 'db',
      predicate: 'has',
      object: 'finding-b',
      tags: ['research-storage'],
    }, '# Fact B\n', 'agent-fact', { pathOverride: 'facts/research-b.md' });
    store.update(
      workspacePath,
      factB.path,
      { created: new Date(cursorMs + 2_000).toISOString() },
      undefined,
      'agent-fact',
    );

    const thresholdCycle = triggerEngine.runTriggerEngineCycle(workspacePath, {
      actor: 'system',
      now: new Date(cursorMs + 2_500),
    });
    expect(thresholdCycle.fired).toBe(1);
    expect(store.list(workspacePath, 'thread').some((entry) => String(entry.fields.title).includes('Synthesis needed'))).toBe(true);

    const steadyCycle = triggerEngine.runTriggerEngineCycle(workspacePath, {
      actor: 'system',
      now: new Date(cursorMs + 3_500),
    });
    expect(steadyCycle.fired).toBe(0);
    const state = triggerEngine.loadTriggerState(workspacePath);
    expect(state.triggers[synthesis.trigger.path]?.fireCount).toBe(1);
  });

  it('builds trigger dashboard with fire counts and next fire', () => {
    const cronTrigger = store.create(workspacePath, 'trigger', {
      title: 'Minutely dispatch',
      status: 'active',
      condition: { type: 'cron', expression: '* * * * *' },
      action: { type: 'dispatch-run', objective: 'Cron dispatch objective' },
      cooldown: 0,
    }, '# Trigger\n', 'system');

    const cycle = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    expect(cycle.fired).toBe(1);

    const dashboard = triggerEngine.triggerDashboard(workspacePath);
    const item = dashboard.triggers.find((trigger) => trigger.path === cronTrigger.path);
    expect(item).toBeDefined();
    expect(item?.fireCount).toBe(1);
    expect(item?.lastFiredAt).toBeDefined();
    expect(item?.nextFireAt).toBeDefined();
    expect(item?.currentState).toBe('ready');
  });
});
