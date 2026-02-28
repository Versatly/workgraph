import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as registry from './registry.js';
import * as store from './store.js';
import * as thread from './thread.js';
import * as threadAudit from './thread-audit.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-thread-audit-'));
  const seeded = registry.loadRegistry(workspacePath);
  registry.saveRegistry(workspacePath, seeded);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('thread audit reconcile', () => {
  it('flags ghost active threads and dependency wiring drift', () => {
    store.create(
      workspacePath,
      'thread',
      {
        title: 'Ghost active thread',
        goal: 'No claim exists',
        status: 'active',
        owner: 'ghost-agent',
      },
      'Depends on [[threads/missing-upstream]] but deps was never set.',
      'seed-agent',
    );

    const tracked = thread.createThread(
      workspacePath,
      'Tracked thread',
      'Depends on threads/known-upstream.md',
      'seed-agent',
    );
    thread.claim(workspacePath, tracked.path, 'tracked-agent', { leaseTtlMinutes: 0 });

    const report = threadAudit.reconcileThreadState(workspacePath);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.kind === 'active_without_claim')).toBe(true);
    expect(report.issues.some((issue) => issue.kind === 'dependency_reference_not_declared')).toBe(true);
    expect(report.issues.some((issue) => issue.kind === 'stale_lease')).toBe(true);
  });
});
