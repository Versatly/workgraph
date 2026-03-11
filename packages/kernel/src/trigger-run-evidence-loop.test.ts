import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerDefaultDispatchAdaptersIntoKernelRegistry } from '@versatly/workgraph-runtime-adapter-core';
import { loadRegistry, saveRegistry } from './registry.js';
import * as dispatch from './dispatch.js';
import * as store from './store.js';
import * as thread from './thread.js';
import {
  runTriggerRunEvidenceLoop,
} from './trigger-engine.js';
import { fireTriggerAndExecute } from './trigger.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-trigger-run-loop-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
  registerDefaultDispatchAdaptersIntoKernelRegistry();
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('trigger -> run -> evidence loop', () => {
  it('executes dispatch runs for all trigger condition types', async () => {
    const command = `"${process.execPath}" -e "console.log('loop-ok'); console.log('tests: 2 passed, 0 failed'); console.log('https://github.com/versatly/workgraph/pull/5150');"`;
    const cronTrigger = createDispatchTrigger('Cron dispatch', {
      type: 'cron',
      expression: '* * * * *',
    }, command);
    const eventTrigger = createDispatchTrigger('Event dispatch', {
      type: 'event',
      event: 'thread-complete',
    }, command);
    const fileTrigger = createDispatchTrigger('File dispatch', {
      type: 'file-watch',
      glob: 'facts/**/*.md',
    }, command);
    const threadCompleteTrigger = createDispatchTrigger('Thread-complete dispatch', {
      type: 'thread-complete',
    }, command);

    await runTriggerRunEvidenceLoop(workspacePath, {
      actor: 'system',
      now: new Date('2026-03-01T00:00:00.000Z'),
      execution: { timeoutMs: 10_000 },
    });

    const completedThread = thread.createThread(workspacePath, 'Trigger source', 'Complete this thread', 'agent-trigger');
    thread.claim(workspacePath, completedThread.path, 'agent-trigger');
    thread.done(
      workspacePath,
      completedThread.path,
      'agent-trigger',
      'Completed https://github.com/versatly/workgraph/pull/500',
    );
    store.create(workspacePath, 'fact', {
      title: 'Changed fact',
      subject: 'system',
      predicate: 'state',
      object: 'updated',
      tags: ['ops'],
    }, '# Fact\n', 'agent-trigger', { pathOverride: 'facts/trigger-change.md' });

    const second = await runTriggerRunEvidenceLoop(workspacePath, {
      actor: 'system',
      now: new Date('2026-03-01T00:01:00.000Z'),
      execution: { timeoutMs: 10_000 },
    });
    expect(second.executedRuns.length).toBeGreaterThanOrEqual(3);
    expect(second.failed).toBe(0);

    const triggeredRuns = dispatch.listRuns(workspacePath)
      .filter((run) => typeof run.context?.trigger_path === 'string');
    const runsByTriggerPath = new Map<string, typeof triggeredRuns[number][]>();
    for (const run of triggeredRuns) {
      const triggerPath = String(run.context?.trigger_path);
      const bucket = runsByTriggerPath.get(triggerPath) ?? [];
      bucket.push(run);
      runsByTriggerPath.set(triggerPath, bucket);
    }
    expect(runsByTriggerPath.get(cronTrigger.path)?.some((run) => run.status === 'succeeded')).toBe(true);
    expect(runsByTriggerPath.get(eventTrigger.path)?.some((run) => run.status === 'succeeded')).toBe(true);
    expect(runsByTriggerPath.get(fileTrigger.path)?.some((run) => run.status === 'succeeded')).toBe(true);
    expect(runsByTriggerPath.get(threadCompleteTrigger.path)?.some((run) => run.status === 'succeeded')).toBe(true);
  });

  it('supports manual trigger fire -> execute flow', async () => {
    const triggerPrimitive = createDispatchTrigger('Manual dispatch', {
      type: 'event',
      event: 'manual',
    }, `"${process.execPath}" -e "console.log('manual-run');"`);

    const result = await fireTriggerAndExecute(workspacePath, triggerPrimitive.path, {
      actor: 'agent-manual',
      eventKey: 'manual-evt-1',
      adapter: 'shell-worker',
      execute: true,
      executeInput: {
        timeoutMs: 10_000,
      },
    });

    expect(result.executed).toBe(true);
    expect(result.run.status).toBe('succeeded');
    expect((result.run.evidenceChain?.count ?? 0) > 0).toBe(true);
  });
});

function createDispatchTrigger(
  title: string,
  condition: Record<string, unknown>,
  shellCommand: string,
) {
  return store.create(workspacePath, 'trigger', {
    title,
    status: 'active',
    condition,
    action: {
      type: 'dispatch-run',
      objective: `${title} objective`,
      adapter: 'shell-worker',
      context: {
        shell_command: shellCommand,
      },
    },
    cooldown: 0,
  }, '# Trigger\n', 'system');
}
