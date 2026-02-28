import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import * as thread from './thread.js';
import * as store from './store.js';
import * as dispatch from './dispatch.js';
import * as lens from './lens.js';
import * as ledger from './ledger.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-lens-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('context lenses', () => {
  it('lists built-in context lenses', () => {
    const lenses = lens.listContextLenses();
    expect(lenses.map((entry) => entry.id)).toEqual([
      'my-work',
      'team-risk',
      'customer-health',
      'exec-brief',
    ]);
  });

  it('generates my-work lens with actor-centric workload and ready queue', () => {
    thread.createThread(workspacePath, 'Own active thread', 'Implement API', 'agent-lead', {
      priority: 'high',
    });
    thread.createThread(workspacePath, 'Blocked customer task', 'Unblock customer rollout', 'agent-lead', {
      priority: 'urgent',
      tags: ['customer'],
    });
    thread.createThread(workspacePath, 'Ready backlog item', 'Pick me next', 'agent-lead', {
      priority: 'medium',
    });

    thread.claim(workspacePath, 'threads/own-active-thread.md', 'agent-alpha');
    thread.claim(workspacePath, 'threads/blocked-customer-task.md', 'agent-alpha');
    thread.block(
      workspacePath,
      'threads/blocked-customer-task.md',
      'agent-alpha',
      'external/customer-api',
      'Waiting for customer token',
    );

    const result = lens.generateContextLens(workspacePath, 'my-work', {
      actor: 'agent-alpha',
      staleHours: 999,
      lookbackHours: 24,
      limit: 5,
    });

    expect(result.lens).toBe('my-work');
    expect(result.metrics.myClaims).toBe(2);
    expect(result.metrics.blocked).toBe(1);
    expect(result.metrics.nextReady).toBe(1);
    expect(result.sections.map((section) => section.id)).toEqual([
      'my_claims',
      'my_blockers',
      'stale_claims',
      'next_ready',
    ]);
    expect(result.markdown).toContain('# Workgraph Context Lens: my-work');
  });

  it('generates team-risk, customer-health, and exec-brief lenses', () => {
    thread.createThread(workspacePath, 'Critical dependency outage', 'Restore service', 'agent-lead', {
      priority: 'urgent',
      tags: ['customer'],
    });
    thread.createThread(workspacePath, 'Finish auth rollout', 'Ship auth', 'agent-lead', {
      priority: 'high',
      tags: ['customer'],
    });
    thread.claim(workspacePath, 'threads/critical-dependency-outage.md', 'agent-risk');
    thread.block(
      workspacePath,
      'threads/critical-dependency-outage.md',
      'agent-risk',
      'external/provider',
      'Provider outage',
    );
    thread.claim(workspacePath, 'threads/finish-auth-rollout.md', 'agent-risk');
    thread.done(workspacePath, 'threads/finish-auth-rollout.md', 'agent-risk', 'Auth shipped');

    const failedRun = dispatch.createRun(workspacePath, {
      actor: 'agent-ops',
      objective: 'Run deployment checks',
      adapter: 'cursor-cloud',
      idempotencyKey: 'lens-failed-run',
    });
    dispatch.markRun(workspacePath, failedRun.id, 'agent-ops', 'running');
    dispatch.markRun(workspacePath, failedRun.id, 'agent-ops', 'failed', {
      error: 'Smoke test failed',
    });

    store.create(
      workspacePath,
      'incident',
      {
        title: 'Customer login outage',
        severity: 'sev1',
        status: 'active',
        tags: ['customer'],
      },
      'Major login outage in production.',
      'system',
    );
    store.create(
      workspacePath,
      'decision',
      {
        title: 'Adopt staged rollout policy',
        date: new Date().toISOString(),
        status: 'approved',
      },
      'Use staged rollout for all customer-facing deploys.',
      'system',
    );

    const teamRisk = lens.generateContextLens(workspacePath, 'team-risk', {
      actor: 'agent-ops',
      lookbackHours: 24,
      staleHours: 24,
      limit: 10,
    });
    expect(teamRisk.metrics.blockedHighPriority).toBe(1);
    expect(teamRisk.metrics.failedRuns).toBe(1);
    expect(teamRisk.metrics.activeHighSeverityIncidents).toBe(1);

    const customerHealth = lens.generateContextLens(workspacePath, 'customer-health', {
      actor: 'agent-ops',
      limit: 10,
    });
    expect(customerHealth.metrics.activeCustomerThreads).toBeGreaterThanOrEqual(1);
    expect(customerHealth.metrics.blockedCustomerThreads).toBe(1);
    expect(customerHealth.metrics.customerIncidents).toBe(1);

    const execBrief = lens.generateContextLens(workspacePath, 'exec-brief', {
      actor: 'agent-ops',
      lookbackHours: 24,
      limit: 10,
    });
    expect(execBrief.metrics.topPriorities).toBeGreaterThanOrEqual(1);
    expect(execBrief.metrics.momentumDone).toBe(1);
    expect(execBrief.metrics.decisions).toBe(1);
  });

  it('materializes lens markdown inside workspace and appends lens ledger event', () => {
    thread.createThread(workspacePath, 'Draft release notes', 'Prepare release notes', 'agent-lead');
    const result = lens.materializeContextLens(workspacePath, 'my-work', {
      actor: 'agent-lead',
      outputPath: 'ops/lenses/my-work.md',
      staleHours: 24,
      lookbackHours: 24,
      limit: 5,
    });

    const outputPath = path.join(workspacePath, 'ops/lenses/my-work.md');
    expect(result.outputPath).toBe('ops/lenses/my-work.md');
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(result.markdown).toContain('# Workgraph Context Lens: my-work');

    const entries = ledger.readAll(workspacePath);
    const lensEntries = entries.filter((entry) => entry.type === 'lens');
    expect(lensEntries).toHaveLength(1);
    expect(lensEntries[0].target).toBe('ops/lenses/my-work.md');
  });

  it('rejects lens materialization outside workspace', () => {
    expect(() => lens.materializeContextLens(workspacePath, 'my-work', {
      actor: 'agent-lead',
      outputPath: '../outside.md',
      staleHours: 24,
      lookbackHours: 24,
      limit: 5,
    })).toThrow('Invalid lens output path');
  });
});
