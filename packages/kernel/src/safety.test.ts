import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SAFETY_CONFIG_FILE,
  ensureSafetyConfig,
  evaluateSafety,
  getSafetyStatus,
  listSafetyEvents,
  pauseSafetyOperations,
  recordOperationOutcome,
  resetSafetyRails,
  resumeSafetyOperations,
  runWithSafetyRails,
  updateSafetyConfig,
  loadSafetyConfig,
} from './safety.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-safety-'));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('safety rails', () => {
  it('creates default .workgraph/safety.yaml when missing', () => {
    const config = ensureSafetyConfig(workspacePath);
    expect(fs.existsSync(path.join(workspacePath, SAFETY_CONFIG_FILE))).toBe(true);
    expect(config.rateLimit.enabled).toBe(true);
    expect(config.circuitBreaker.enabled).toBe(true);
    expect(config.killSwitch.engaged).toBe(false);
  });

  it('blocks operations when rate limit is exceeded and unblocks after window reset', () => {
    updateSafetyConfig(workspacePath, 'ops-admin', {
      rateLimit: {
        enabled: true,
        maxOperations: 2,
        windowSeconds: 60,
      },
      circuitBreaker: {
        enabled: false,
      },
    });

    const baseNow = new Date('2026-03-06T10:00:00.000Z');
    const first = evaluateSafety(workspacePath, {
      actor: 'auto-1',
      operation: 'autonomy.cycle',
      now: baseNow,
      consume: true,
    });
    const second = evaluateSafety(workspacePath, {
      actor: 'auto-1',
      operation: 'autonomy.cycle',
      now: baseNow,
      consume: true,
    });
    const blocked = evaluateSafety(workspacePath, {
      actor: 'auto-1',
      operation: 'autonomy.cycle',
      now: baseNow,
      consume: true,
    });
    const afterWindow = evaluateSafety(workspacePath, {
      actor: 'auto-1',
      operation: 'autonomy.cycle',
      now: new Date(baseNow.getTime() + 61_000),
      consume: true,
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons.join(' ')).toContain('Rate limit exceeded');
    expect(afterWindow.allowed).toBe(true);
  });

  it('opens circuit breaker after repeated failures and closes after cooldown + successful probe', () => {
    updateSafetyConfig(workspacePath, 'ops-admin', {
      rateLimit: {
        enabled: false,
      },
      circuitBreaker: {
        enabled: true,
        failureThreshold: 2,
        cooldownSeconds: 30,
        halfOpenMaxOperations: 1,
      },
    });

    const t0 = new Date('2026-03-06T11:00:00.000Z');
    evaluateSafety(workspacePath, { actor: 'auto-2', operation: 'autonomy.run', now: t0, consume: true });
    recordOperationOutcome(workspacePath, {
      actor: 'auto-2',
      operation: 'autonomy.run',
      success: false,
      error: 'first failure',
      now: t0,
    });

    evaluateSafety(workspacePath, { actor: 'auto-2', operation: 'autonomy.run', now: t0, consume: true });
    recordOperationOutcome(workspacePath, {
      actor: 'auto-2',
      operation: 'autonomy.run',
      success: false,
      error: 'second failure',
      now: t0,
    });

    const blocked = evaluateSafety(workspacePath, {
      actor: 'auto-2',
      operation: 'autonomy.run',
      now: new Date(t0.getTime() + 1_000),
      consume: true,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons.join(' ')).toContain('Circuit breaker open');

    const probeTime = new Date(t0.getTime() + 31_000);
    const probe = evaluateSafety(workspacePath, {
      actor: 'auto-2',
      operation: 'autonomy.run',
      now: probeTime,
      consume: true,
    });
    expect(probe.allowed).toBe(true);

    recordOperationOutcome(workspacePath, {
      actor: 'auto-2',
      operation: 'autonomy.run',
      success: true,
      now: probeTime,
    });

    const status = getSafetyStatus(workspacePath, new Date(t0.getTime() + 32_000));
    expect(status.config.runtime.circuitState).toBe('closed');
  });

  it('enforces kill switch pause/resume and writes ledger events', () => {
    pauseSafetyOperations(workspacePath, 'ops-admin', 'manual incident response');
    const pausedDecision = evaluateSafety(workspacePath, {
      actor: 'auto-3',
      operation: 'autonomy.run',
      consume: false,
    });
    expect(pausedDecision.allowed).toBe(false);
    expect(pausedDecision.reasons.join(' ')).toContain('Kill switch engaged');

    resumeSafetyOperations(workspacePath, 'ops-admin');
    const resumedDecision = evaluateSafety(workspacePath, {
      actor: 'auto-3',
      operation: 'autonomy.run',
      consume: false,
    });
    expect(resumedDecision.allowed).toBe(true);

    const events = listSafetyEvents(workspacePath, { count: 10 });
    const eventNames = events.map((entry) => String(entry.data?.event ?? ''));
    expect(eventNames).toContain('safety.kill_switch.engaged');
    expect(eventNames).toContain('safety.kill_switch.released');
  });

  it('resets runtime counters and can clear kill switch', () => {
    updateSafetyConfig(workspacePath, 'ops-admin', {
      rateLimit: {
        enabled: true,
        maxOperations: 1,
        windowSeconds: 600,
      },
      circuitBreaker: {
        enabled: true,
        failureThreshold: 1,
        cooldownSeconds: 600,
        halfOpenMaxOperations: 1,
      },
    });
    pauseSafetyOperations(workspacePath, 'ops-admin', 'maintenance');

    evaluateSafety(workspacePath, {
      actor: 'auto-4',
      operation: 'autonomy.run',
      consume: true,
    });
    recordOperationOutcome(workspacePath, {
      actor: 'auto-4',
      operation: 'autonomy.run',
      success: false,
      error: 'failure before reset',
    });

    const reset = resetSafetyRails(workspacePath, {
      actor: 'ops-admin',
      clearKillSwitch: true,
    });
    expect(reset.runtime.consecutiveFailures).toBe(0);
    expect(reset.runtime.circuitState).toBe('closed');
    expect(reset.runtime.rateLimitOperations).toBe(0);
    expect(reset.killSwitch.engaged).toBe(false);
  });

  it('guards operation execution via runWithSafetyRails', async () => {
    updateSafetyConfig(workspacePath, 'ops-admin', {
      rateLimit: {
        enabled: false,
      },
      circuitBreaker: {
        enabled: true,
        failureThreshold: 1,
        cooldownSeconds: 120,
        halfOpenMaxOperations: 1,
      },
    });

    await expect(runWithSafetyRails(
      workspacePath,
      {
        actor: 'auto-5',
        operation: 'autonomy.dispatch',
      },
      () => {
        throw new Error('adapter failed');
      },
    )).rejects.toThrow('adapter failed');

    let invoked = false;
    await expect(runWithSafetyRails(
      workspacePath,
      {
        actor: 'auto-5',
        operation: 'autonomy.dispatch',
      },
      () => {
        invoked = true;
        return 'ok';
      },
    )).rejects.toThrow('Safety rails blocked');
    expect(invoked).toBe(false);

    const config = loadSafetyConfig(workspacePath);
    expect(config.runtime.circuitState).toBe('open');
  });
});
