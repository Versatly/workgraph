import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimLeasePath,
  listClaimLeases,
  recoverClaimLeaseState,
  removeClaimLease,
  setClaimLease,
} from './claim-lease.js';
import { InputValidationError } from './errors.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-claim-lease-core-'));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('claim-lease core module', () => {
  it('resolves lease state path under .workgraph', () => {
    expect(claimLeasePath(workspacePath)).toBe(
      path.join(workspacePath, '.workgraph', 'claim-leases.json'),
    );
  });

  it('creates and lists leases sorted by target', () => {
    const baseNow = new Date('2026-01-01T00:00:00.000Z');
    setClaimLease(workspacePath, 'threads/b.md', 'agent-b', { now: baseNow });
    setClaimLease(workspacePath, 'threads/a.md', 'agent-a', { now: baseNow });

    const leases = listClaimLeases(workspacePath, baseNow.getTime());
    expect(leases).toHaveLength(2);
    expect(leases.map((entry) => entry.target)).toEqual([
      'threads/a.md',
      'threads/b.md',
    ]);
    expect(leases.every((entry) => entry.stale === false)).toBe(true);
  });

  it('preserves original claimedAt when refreshing an existing lease', () => {
    const initialNow = new Date('2026-01-01T00:00:00.000Z');
    const refreshedNow = new Date('2026-01-01T00:10:00.000Z');
    const created = setClaimLease(workspacePath, 'threads/job.md', 'agent-a', {
      now: initialNow,
      ttlMinutes: 20,
    });

    const refreshed = setClaimLease(workspacePath, 'threads/job.md', 'agent-a', {
      now: refreshedNow,
      ttlMinutes: 30,
    });

    expect(refreshed.claimedAt).toBe(created.claimedAt);
    expect(refreshed.lastHeartbeatAt).toBe(refreshedNow.toISOString());
    expect(refreshed.ttlMinutes).toBe(30);
  });

  it('normalizes ttl bounds to 0..1440 minutes', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const zeroLease = setClaimLease(workspacePath, 'threads/zero.md', 'agent-z', {
      now,
      ttlMinutes: -5,
    });
    expect(zeroLease.ttlMinutes).toBe(0);
    expect(zeroLease.expiresAt).toBe(now.toISOString());

    const capped = setClaimLease(workspacePath, 'threads/capped.md', 'agent-c', {
      now,
      ttlMinutes: 5_000,
    });
    expect(capped.ttlMinutes).toBe(24 * 60);
  });

  it('marks stale leases based on provided nowMs', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    setClaimLease(workspacePath, 'threads/stale-check.md', 'agent-s', {
      now,
      ttlMinutes: 1,
    });

    const fresh = listClaimLeases(workspacePath, now.getTime() + 30_000)[0];
    expect(fresh.stale).toBe(false);
    expect(fresh.msUntilExpiry).toBeGreaterThan(0);

    const stale = listClaimLeases(workspacePath, now.getTime() + 120_000)[0];
    expect(stale.stale).toBe(true);
    expect(stale.msUntilExpiry).toBeLessThanOrEqual(0);
  });

  it('removes leases and no-ops for unknown targets', () => {
    setClaimLease(workspacePath, 'threads/to-remove.md', 'agent-r');
    expect(listClaimLeases(workspacePath)).toHaveLength(1);

    removeClaimLease(workspacePath, 'threads/to-remove.md');
    expect(listClaimLeases(workspacePath)).toHaveLength(0);

    expect(() => removeClaimLease(workspacePath, 'threads/not-present.md')).not.toThrow();
  });

  it('validates boundary inputs with typed errors', () => {
    expect(() => setClaimLease(workspacePath, 'invalid-thread-ref', 'agent-a')).toThrow(InputValidationError);
    expect(() => setClaimLease(workspacePath, 'threads/valid.md', '??')).toThrow(InputValidationError);
  });

  it('repairs malformed lease records during recovery', () => {
    const filePath = claimLeasePath(workspacePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      leases: {
        'threads/broken.md': {
          target: 'threads/broken.md',
          owner: 'agent-fix',
          claimedAt: 'not-a-date',
          lastHeartbeatAt: 'also-bad',
          expiresAt: 'still-bad',
          ttlMinutes: 5_000,
        },
        'threads/remove.md': {
          owner: '',
        },
      },
    }, null, 2), 'utf-8');

    const report = recoverClaimLeaseState(workspacePath, Date.parse('2026-01-01T00:00:00.000Z'));
    expect(report.inspected).toBeGreaterThanOrEqual(1);
    const leases = listClaimLeases(workspacePath);
    expect(leases.some((entry) => entry.target === 'threads/broken.md')).toBe(true);
    expect(leases.some((entry) => entry.target === 'threads/remove.md')).toBe(false);
    expect(leases.find((entry) => entry.target === 'threads/broken.md')?.ttlMinutes).toBe(24 * 60);
  });
});
