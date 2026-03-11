import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ledger as ledgerModule,
  safety as safetyModule,
  store as storeModule,
  triggerEngine as triggerEngineModule,
  workspace as workspaceModule,
} from '@versatly/workgraph-kernel';

const ledger = ledgerModule;
const safety = safetyModule;
const store = storeModule;
const triggerEngine = triggerEngineModule;
const workspace = workspaceModule;

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-stress-trigger-cascade-'));
  workspace.initWorkspace(workspacePath, { createReadme: false });
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('stress: trigger cascade, throttling, and breaker behavior', () => {
  it('handles deep cascades and 100+ trigger fan-out while safety rails enforce limits', { timeout: 30_000 }, () => {
    const cascadeLength = 50;
    for (let idx = 1; idx <= cascadeLength; idx += 1) {
      store.create(
        workspacePath,
        'fact',
        {
          title: `Cascade fact ${idx}`,
          subject: 'cascade',
          predicate: 'step',
          object: 'pending',
          tags: ['stress', 'cascade'],
        },
        '# Cascade Fact\n',
        'system',
        { pathOverride: `facts/cascade-${idx}.md` },
      );
    }

    for (let idx = 0; idx < cascadeLength; idx += 1) {
      const eventPattern = idx === 0
        ? 'event.update:events/cascade-seed-0.md'
        : `fact.update:facts/cascade-${idx}.md`;
      store.create(
        workspacePath,
        'trigger',
        {
          title: `Cascade trigger ${idx}`,
          status: 'active',
          condition: { type: 'event', pattern: eventPattern },
          action: {
            type: 'update-primitive',
            path: `facts/cascade-${idx + 1}.md`,
            fields: { object: `fired-${idx}` },
          },
          cooldown: 0,
          tags: ['stress', 'cascade'],
        },
        '# Trigger\n',
        'system',
        { pathOverride: `triggers/cascade-${idx}.md` },
      );
    }

    triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
    ledger.append(
      workspacePath,
      'system',
      'update',
      'events/cascade-seed-0.md',
      'event',
      { event_type: 'cascade.seed' },
    );

    let totalCascadeFires = 0;
    for (let cycle = 0; cycle < cascadeLength + 10; cycle += 1) {
      const result = triggerEngine.runTriggerEngineCycle(workspacePath, { actor: 'system' });
      totalCascadeFires += result.fired;
      if (result.fired === 0) break;
    }
    expect(totalCascadeFires).toBe(cascadeLength);

    for (let idx = 1; idx <= cascadeLength; idx += 1) {
      const fact = store.read(workspacePath, `facts/cascade-${idx}.md`);
      expect(fact?.fields.object).toBe(`fired-${idx - 1}`);
    }

    safety.updateSafetyConfig(workspacePath, 'safety-admin', {
      rateLimit: { enabled: false },
      circuitBreaker: {
        enabled: true,
        failureThreshold: 3,
        cooldownSeconds: 30,
        halfOpenMaxOperations: 1,
      },
    });
    const breakerStart = new Date('2026-03-06T12:00:00.000Z');
    for (let idx = 0; idx < 3; idx += 1) {
      const now = new Date(breakerStart.getTime() + idx * 1000);
      const decision = safety.evaluateSafety(workspacePath, {
        actor: 'system-trigger',
        operation: 'trigger.evaluate',
        now,
        consume: true,
      });
      expect(decision.allowed).toBe(true);
      safety.recordOperationOutcome(workspacePath, {
        actor: 'system-trigger',
        operation: 'trigger.evaluate',
        success: false,
        error: `synthetic failure ${idx}`,
        now,
      });
    }
    const breakerBlocked = safety.evaluateSafety(workspacePath, {
      actor: 'system-trigger',
      operation: 'trigger.evaluate',
      now: new Date(breakerStart.getTime() + 4_000),
      consume: true,
    });
    expect(breakerBlocked.allowed).toBe(false);
    expect(breakerBlocked.reasons.join(' ')).toContain('Circuit breaker open');

    safety.resetSafetyRails(workspacePath, { actor: 'safety-admin', clearKillSwitch: true });
    safety.updateSafetyConfig(workspacePath, 'safety-admin', {
      rateLimit: {
        enabled: true,
        windowSeconds: 60,
        maxOperations: 5,
      },
      circuitBreaker: { enabled: false },
    });
    const rateLimitNow = new Date('2026-03-06T12:10:00.000Z');
    const decisions = Array.from({ length: 6 }, () =>
      safety.evaluateSafety(workspacePath, {
        actor: 'system-trigger',
        operation: 'trigger.evaluate',
        now: rateLimitNow,
        consume: true,
      }));
    expect(decisions.slice(0, 5).every((entry) => entry.allowed)).toBe(true);
    expect(decisions[5]?.allowed).toBe(false);
    expect(decisions[5]?.reasons.join(' ')).toContain('Rate limit exceeded');

    safety.resetSafetyRails(workspacePath, { actor: 'safety-admin', clearKillSwitch: true });
    safety.updateSafetyConfig(workspacePath, 'safety-admin', {
      rateLimit: {
        enabled: false,
      },
      circuitBreaker: { enabled: false },
    });

    const bulkCount = 120;
    const bulkTriggerPaths: string[] = [];
    for (let idx = 0; idx < bulkCount; idx += 1) {
      store.create(
        workspacePath,
        'fact',
        {
          title: `Bulk fact ${idx}`,
          subject: 'bulk',
          predicate: 'fanout',
          object: 'pending',
          tags: ['stress', 'bulk'],
        },
        '# Bulk Fact\n',
        'system',
        { pathOverride: `facts/bulk-${idx}.md` },
      );
      const trigger = store.create(
        workspacePath,
        'trigger',
        {
          title: `Bulk trigger ${idx}`,
          status: 'active',
          condition: { type: 'event', pattern: 'event.update:events/bulk-seed.md' },
          action: {
            type: 'update-primitive',
            path: `facts/bulk-${idx}.md`,
            fields: { object: `bulk-fired-${idx}` },
          },
          cooldown: 0,
          tags: ['stress', 'bulk'],
        },
        '# Trigger\n',
        'system',
        { pathOverride: `triggers/bulk-${idx}.md` },
      );
      bulkTriggerPaths.push(trigger.path);
    }

    triggerEngine.runTriggerEngineCycle(workspacePath, {
      actor: 'system',
      triggerPaths: bulkTriggerPaths,
    });
    ledger.append(
      workspacePath,
      'system',
      'update',
      'events/bulk-seed.md',
      'event',
      { event_type: 'bulk.seed' },
    );
    const bulkResult = triggerEngine.runTriggerEngineCycle(workspacePath, {
      actor: 'system',
      triggerPaths: bulkTriggerPaths,
    });
    expect(bulkResult.fired).toBe(bulkCount);
    expect(bulkResult.errors).toBe(0);
  });
});
