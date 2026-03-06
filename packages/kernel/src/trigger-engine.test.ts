import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    thread.done(workspacePath, seededThread.path, 'agent-dev', 'Parser complete https://github.com/versatly/workgraph/pull/11');

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

  it('matches event trigger patterns against ledger events', () => {
    const patternTrigger = store.create(workspacePath, 'trigger', {
      title: 'Pattern match done events',
      type: 'event',
      enabled: true,
      status: 'active',
      condition: { type: 'event', pattern: 'thread.*' },
      action: {
        type: 'create-thread',
        title: 'Pattern follow-up {{matched_event_latest_target}}',
        goal: 'Validate wildcard pattern matching',
      },
      cooldown: 0,
    }, '# Trigger\n', 'system');

    const seed = thread.createThread(workspacePath, 'Pattern source', 'Complete source thread', 'agent-pattern');
    thread.claim(workspacePath, seed.path, 'agent-pattern');
    thread.done(workspacePath, seed.path, 'agent-pattern', 'Done https://github.com/versatly/workgraph/pull/33');

    const first = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    expect(first.fired).toBe(0);

    const another = thread.createThread(workspacePath, 'Pattern source 2', 'Second completion', 'agent-pattern');
    thread.claim(workspacePath, another.path, 'agent-pattern');
    thread.done(workspacePath, another.path, 'agent-pattern', 'Done https://github.com/versatly/workgraph/pull/34');

    const second = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    expect(second.fired).toBe(1);
    const triggerResult = second.triggers.find((entry) => entry.triggerPath === patternTrigger.path);
    expect(triggerResult?.reason).toContain('Matched');
    expect(store.list(workspacePath, 'thread').some((entry) =>
      String(entry.fields.title).startsWith('Pattern follow-up'))
    ).toBe(true);
  });

  it('does not auto-fire manual triggers during engine cycles', () => {
    const manualTrigger = store.create(workspacePath, 'trigger', {
      title: 'Manual only trigger',
      type: 'manual',
      enabled: true,
      status: 'active',
      condition: { type: 'manual' },
      action: {
        type: 'dispatch-run',
        objective: 'Manual fire required',
      },
      cooldown: 0,
    }, '# Trigger\n', 'system');

    const cycle = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    expect(cycle.fired).toBe(0);
    const result = cycle.triggers.find((entry) => entry.triggerPath === manualTrigger.path);
    expect(result?.fired).toBe(false);
    expect(result?.reason).toContain('Manual trigger condition requires explicit');
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
    thread.done(workspacePath, sourceThread.path, 'agent-owner', 'Source complete https://github.com/versatly/workgraph/pull/12');

    const threads = store.list(workspacePath, 'thread');
    expect(threads).toHaveLength(2);
    expect(threads.some((entry) => String(entry.fields.title).startsWith('Cascade from'))).toBe(true);

    const state = triggerEngine.loadTriggerState(workspacePath);
    expect(state.triggers[cascadeTrigger.path]?.fireCount).toBe(1);
  });

  it('uses ledger offset cursors so same-timestamp events are not skipped', () => {
    vi.useFakeTimers();
    try {
      const frozenNow = new Date('2026-01-01T00:00:00.000Z');
      vi.setSystemTime(frozenNow);

      const eventTrigger = store.create(workspacePath, 'trigger', {
        title: 'Follow-up on every completed thread',
        status: 'active',
        condition: { type: 'event', event: 'thread-complete' },
        action: {
          type: 'create-thread',
          title: 'Offset follow-up {{matched_event_latest_target}}',
          goal: 'Verify event cursor offset handling',
          tags: ['offset-cursor'],
        },
        cooldown: 0,
      }, '# Trigger\n', 'system');

      const firstThread = thread.createThread(workspacePath, 'Seed completion', 'Initial completion event', 'agent-seed');
      thread.claim(workspacePath, firstThread.path, 'agent-seed');
      thread.done(workspacePath, firstThread.path, 'agent-seed', 'Seed completed https://github.com/versatly/workgraph/pull/13');

      const firstCycle = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system', now: frozenNow });
      expect(firstCycle.fired).toBe(0);
      const firstState = triggerEngine.loadTriggerState(workspacePath);
      const firstOffset = firstState.triggers[eventTrigger.path]?.lastEventCursorOffset;
      expect(typeof firstOffset).toBe('number');
      expect((firstOffset ?? 0) > 0).toBe(true);

      const secondThread = thread.createThread(workspacePath, 'Same-ts completion', 'Second completion at identical timestamp', 'agent-seed');
      thread.claim(workspacePath, secondThread.path, 'agent-seed');
      thread.done(workspacePath, secondThread.path, 'agent-seed', 'Second completed https://github.com/versatly/workgraph/pull/14');

      const secondCycle = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system', now: frozenNow });
      expect(secondCycle.fired).toBe(1);
      expect(store.list(workspacePath, 'thread').some((entry) =>
        String(entry.fields.title).startsWith('Offset follow-up'))
      ).toBe(true);

      const secondState = triggerEngine.loadTriggerState(workspacePath);
      const secondOffset = secondState.triggers[eventTrigger.path]?.lastEventCursorOffset;
      expect((secondOffset ?? 0) > (firstOffset ?? 0)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
