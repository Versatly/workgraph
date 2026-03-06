import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ledger as ledgerModule,
  registry as registryModule,
  store as storeModule,
  thread as threadModule,
  threadAudit as threadAuditModule,
} from '@versatly/workgraph-kernel';

const ledger = ledgerModule;
const registry = registryModule;
const store = storeModule;
const thread = threadModule;
const threadAudit = threadAuditModule;

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-stress-concurrent-threads-'));
  registry.saveRegistry(workspacePath, registry.loadRegistry(workspacePath));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('stress: concurrent thread claims/releases', () => {
  it('handles 100 threads and 10 agents without double-claims or deadlocks', { timeout: 30_000 }, async () => {
    const threadCount = 100;
    const agents = Array.from({ length: 10 }, (_, idx) => `agent-${idx}`);

    await Promise.all(
      Array.from({ length: threadCount }, (_value, idx) =>
        Promise.resolve().then(() =>
          thread.createThread(
            workspacePath,
            `Stress thread ${idx}`,
            `Exercise claim/release contention path for thread ${idx}.`,
            'seed-agent',
          )),
      ),
    );

    const targets = store.list(workspacePath, 'thread').map((entry) => entry.path);
    expect(targets).toHaveLength(threadCount);

    const completed = new Set<string>();
    const activeClaims = new Map<string, string>();
    const doubleClaimViolations: string[] = [];
    const maxAttemptsPerAgent = 2_000;

    const workers = agents.map(async (agentName) => {
      let attempts = 0;
      while (completed.size < threadCount && attempts < maxAttemptsPerAgent) {
        attempts += 1;
        const remaining = targets.filter((target) => !completed.has(target));
        if (remaining.length === 0) break;
        const target = remaining[Math.floor(Math.random() * remaining.length)];
        if (!target) continue;

        try {
          thread.claim(workspacePath, target, agentName, { leaseTtlMinutes: 2 });
          const current = activeClaims.get(target);
          if (current && current !== agentName) {
            doubleClaimViolations.push(`${target}:${current}->${agentName}`);
          }
          activeClaims.set(target, agentName);

          thread.release(workspacePath, target, agentName, 'stress-release');
          activeClaims.delete(target);
          completed.add(target);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const expectedContention = (
            message.includes('already claimed')
            || message.includes('Cannot claim thread in "active" state')
            || message.includes('currently being claimed')
          );
          if (!expectedContention) {
            throw error;
          }
        }

        await Promise.resolve();
      }
    });

    await Promise.all(workers);

    expect(completed.size).toBe(threadCount);
    expect(doubleClaimViolations).toEqual([]);

    const threadsAfter = store.list(workspacePath, 'thread');
    for (const entry of threadsAfter) {
      expect(entry.fields.status).toBe('open');
      expect(entry.fields.owner ?? null).toBeNull();
    }

    const leases = thread.listClaimLeaseStatus(workspacePath);
    expect(leases).toHaveLength(0);

    const verify = ledger.verifyHashChain(workspacePath, { strict: true });
    expect(verify.ok).toBe(true);
    expect(verify.issues).toEqual([]);

    for (const target of targets) {
      const history = ledger.historyOf(workspacePath, target);
      let claimed = false;
      for (const entry of history) {
        if (entry.op === 'claim') {
          expect(claimed).toBe(false);
          claimed = true;
        }
        if (entry.op === 'release' || entry.op === 'done' || entry.op === 'cancel' || entry.op === 'reopen') {
          claimed = false;
        }
      }
      expect(claimed).toBe(false);
    }

    const deadlockTarget = thread.createThread(
      workspacePath,
      'Deadlock contention target',
      'Ensure stale claim lock does not deadlock.',
      'seed-agent',
    ).path;
    const lockName = `${crypto.createHash('sha1').update(deadlockTarget).digest('hex')}.lock`;
    const lockPath = path.join(workspacePath, '.workgraph', 'locks', lockName);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999_999,
      target: deadlockTarget,
      createdAt: '2000-01-01T00:00:00.000Z',
    }) + '\n', 'utf-8');

    const deadlockStart = Date.now();
    thread.claim(workspacePath, deadlockTarget, 'agent-deadlock-check');
    thread.release(workspacePath, deadlockTarget, 'agent-deadlock-check', 'deadlock-check');
    const deadlockDurationMs = Date.now() - deadlockStart;
    expect(deadlockDurationMs).toBeLessThan(2_000);

    const audit = threadAudit.reconcileThreadState(workspacePath);
    expect(audit.ok).toBe(true);
    expect(audit.issues).toEqual([]);
  });
});
