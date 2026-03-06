import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as registry from './registry.js';
import * as store from './store.js';
import * as dispatch from './dispatch.js';
import * as safety from './safety.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-safety-'));
  registry.saveRegistry(workspacePath, registry.loadRegistry(workspacePath));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('safety rails', () => {
  it('enforces per-agent dispatch rate limits', () => {
    const config = safety.loadRuntimeConfig(workspacePath);
    config.safety.rateLimiting.maxDispatchesPerMinutePerAgent = 1;
    config.safety.rateLimiting.maxDispatchesPerHourPerAgent = 10;
    config.safety.rateLimiting.maxConcurrentRunsPerAgent = 10;
    safety.saveRuntimeConfig(workspacePath, config);

    safety.assertAutomatedDispatchAllowed(workspacePath, {
      agent: 'agent-rate',
      source: 'test',
      actor: 'agent-rate',
    });
    expect(() =>
      safety.assertAutomatedDispatchAllowed(workspacePath, {
        agent: 'agent-rate',
        source: 'test',
        actor: 'agent-rate',
      })
    ).toThrow('max 1 dispatches/minute');

    const events = safety.readSafetyLog(workspacePath, { agent: 'agent-rate' });
    expect(events.some((entry) => entry.event === 'dispatch-blocked-rate-limit-minute')).toBe(true);
  });

  it('enforces per-agent concurrent run limits', () => {
    const config = safety.loadRuntimeConfig(workspacePath);
    config.safety.rateLimiting.maxDispatchesPerMinutePerAgent = 100;
    config.safety.rateLimiting.maxDispatchesPerHourPerAgent = 100;
    config.safety.rateLimiting.maxConcurrentRunsPerAgent = 1;
    safety.saveRuntimeConfig(workspacePath, config);

    dispatch.createRun(workspacePath, {
      actor: 'agent-concurrency',
      objective: 'Existing queued run',
    });
    expect(() =>
      safety.assertAutomatedDispatchAllowed(workspacePath, {
        agent: 'agent-concurrency',
        source: 'test',
        actor: 'agent-concurrency',
      })
    ).toThrow('max 1 active runs');
  });

  it('opens trigger circuit breaker and auto-disables trigger after threshold failures', () => {
    const config = safety.loadRuntimeConfig(workspacePath);
    config.safety.circuitBreaker.maxConsecutiveFailures = 2;
    config.safety.circuitBreaker.autoDisableTrigger = true;
    safety.saveRuntimeConfig(workspacePath, config);

    const trigger = store.create(
      workspacePath,
      'trigger',
      {
        title: 'Failing trigger',
        status: 'active',
        condition: { type: 'cron', expression: '* * * * *' },
        action: { type: 'shell', command: 'exit 1' },
      },
      '# Trigger\n',
      'system',
    );

    safety.recordSafetyOutcome(workspacePath, {
      source: 'test',
      success: false,
      agent: 'agent-breaker',
      triggerPath: trigger.path,
      error: 'boom-1',
      actor: 'system',
    });
    safety.recordSafetyOutcome(workspacePath, {
      source: 'test',
      success: false,
      agent: 'agent-breaker',
      triggerPath: trigger.path,
      error: 'boom-2',
      actor: 'system',
    });

    const disabled = store.read(workspacePath, trigger.path);
    expect(String(disabled?.fields.status)).toBe('paused');
    const status = safety.safetyStatus(workspacePath);
    const triggerCircuit = status.circuitBreaker.triggers.find((entry) => entry.triggerPath === trigger.path);
    expect(triggerCircuit?.open).toBe(true);
    expect(triggerCircuit?.consecutiveFailures).toBe(2);

    const reset = safety.resetSafetyCircuit(workspacePath, trigger.path, 'system');
    expect(reset.targetType).toBe('trigger');
    expect(reset.reEnabledTrigger).toBe(true);
    const reEnabled = store.read(workspacePath, trigger.path);
    expect(String(reEnabled?.fields.status)).toBe('active');
  });
});
