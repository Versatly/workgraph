import fs from 'node:fs';
import path from 'node:path';
import {
  InputValidationError,
  StateCorruptionError,
  asWorkgraphError,
} from './errors.js';
import { atomicWriteFile, withFileLock } from './fs-reliability.js';
import {
  validateActorName,
  validateThreadPath,
  validateWorkspacePath,
} from './validation.js';

const CLAIM_LEASE_FILE = '.workgraph/claim-leases.json';
const CLAIM_LEASE_VERSION = 1;
const DEFAULT_TTL_MINUTES = 30;
const CLAIM_LEASE_LOCK_SCOPE = 'claim-leases-state';

export interface ClaimLeaseRecord {
  target: string;
  owner: string;
  claimedAt: string;
  lastHeartbeatAt: string;
  expiresAt: string;
  ttlMinutes: number;
}

interface ClaimLeaseState {
  version: number;
  leases: Record<string, ClaimLeaseRecord>;
}

export interface ClaimLeaseStatus extends ClaimLeaseRecord {
  stale: boolean;
  msUntilExpiry: number;
}

export interface ClaimLeaseRecoveryResult {
  inspected: number;
  repaired: number;
  removed: number;
  issues: Array<{
    target?: string;
    reason: string;
  }>;
}

export function listClaimLeases(
  workspacePath: string,
  nowMs: number = Date.now(),
): ClaimLeaseStatus[] {
  const safeWorkspacePath = validateWorkspacePath(workspacePath, {
    workspacePath,
    operation: 'claim-lease.list',
  });
  return withClaimLeaseOperation('claim-lease.list', { workspacePath: safeWorkspacePath }, () => {
    const state = loadClaimLeaseState(safeWorkspacePath);
    return Object.values(state.leases)
      .map((lease) => {
        const expiresAtMs = Date.parse(lease.expiresAt);
        const safeExpiry = Number.isFinite(expiresAtMs) ? expiresAtMs : 0;
        const msUntilExpiry = safeExpiry - nowMs;
        return {
          ...lease,
          stale: msUntilExpiry <= 0,
          msUntilExpiry,
        };
      })
      .sort((a, b) => a.target.localeCompare(b.target));
  });
}

export function setClaimLease(
  workspacePath: string,
  target: string,
  owner: string,
  options: {
    ttlMinutes?: number;
    now?: Date;
    claimedAt?: string;
  } = {},
): ClaimLeaseRecord {
  const safeWorkspacePath = validateWorkspacePath(workspacePath, {
    workspacePath,
    operation: 'claim-lease.set',
  });
  const safeTarget = validateThreadPath(target, {
    workspacePath: safeWorkspacePath,
    threadPath: target,
    operation: 'claim-lease.set',
  });
  const safeOwner = validateActorName(owner, {
    workspacePath: safeWorkspacePath,
    threadPath: safeTarget,
    actor: owner,
    operation: 'claim-lease.set',
  });
  return withClaimLeaseOperation(
    'claim-lease.set',
    { workspacePath: safeWorkspacePath, threadPath: safeTarget, actor: safeOwner },
    () =>
      withFileLock(safeWorkspacePath, CLAIM_LEASE_LOCK_SCOPE, () => {
        const state = loadClaimLeaseState(safeWorkspacePath);
        const now = options.now ?? new Date();
        const nowIso = now.toISOString();
        const ttlMinutes = normalizeTtlMinutes(options.ttlMinutes);
        const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
        const record: ClaimLeaseRecord = {
          target: safeTarget,
          owner: safeOwner,
          claimedAt: options.claimedAt ?? state.leases[safeTarget]?.claimedAt ?? nowIso,
          lastHeartbeatAt: nowIso,
          expiresAt,
          ttlMinutes,
        };
        state.leases[safeTarget] = record;
        saveClaimLeaseState(safeWorkspacePath, state);
        return record;
      }),
  );
}

export function removeClaimLease(workspacePath: string, target: string): void {
  const safeWorkspacePath = validateWorkspacePath(workspacePath, {
    workspacePath,
    operation: 'claim-lease.remove',
  });
  const safeTarget = validateThreadPath(target, {
    workspacePath: safeWorkspacePath,
    threadPath: target,
    operation: 'claim-lease.remove',
  });
  return withClaimLeaseOperation('claim-lease.remove', {
    workspacePath: safeWorkspacePath,
    threadPath: safeTarget,
  }, () => {
    withFileLock(safeWorkspacePath, CLAIM_LEASE_LOCK_SCOPE, () => {
      const state = loadClaimLeaseState(safeWorkspacePath);
      if (!state.leases[safeTarget]) return;
      delete state.leases[safeTarget];
      saveClaimLeaseState(safeWorkspacePath, state);
    });
  });
}

export function claimLeasePath(workspacePath: string): string {
  const safeWorkspacePath = validateWorkspacePath(workspacePath, {
    workspacePath,
    operation: 'claim-lease.path',
  });
  return path.join(safeWorkspacePath, CLAIM_LEASE_FILE);
}

export function recoverClaimLeaseState(workspacePath: string, nowMs: number = Date.now()): ClaimLeaseRecoveryResult {
  const safeWorkspacePath = validateWorkspacePath(workspacePath, {
    workspacePath,
    operation: 'claim-lease.recover',
  });
  return withClaimLeaseOperation('claim-lease.recover', { workspacePath: safeWorkspacePath }, () =>
    withFileLock(safeWorkspacePath, CLAIM_LEASE_LOCK_SCOPE, () => {
      const state = loadClaimLeaseState(safeWorkspacePath);
      const issues: ClaimLeaseRecoveryResult['issues'] = [];
      let repaired = 0;
      let removed = 0;

      for (const [target, lease] of Object.entries(state.leases)) {
        if (!lease || typeof lease !== 'object') {
          delete state.leases[target];
          removed += 1;
          issues.push({ target, reason: 'lease entry is not an object' });
          continue;
        }
        const normalizedTarget = String(lease.target ?? '').trim() || target;
        const owner = String(lease.owner ?? '').trim();
        if (!normalizedTarget || !owner) {
          delete state.leases[target];
          removed += 1;
          issues.push({ target, reason: 'missing required target or owner' });
          continue;
        }

        const ttlMinutes = normalizeTtlMinutes(lease.ttlMinutes);
        const claimedAt = normalizeIsoDate(lease.claimedAt, new Date(nowMs).toISOString());
        const lastHeartbeatAt = normalizeIsoDate(lease.lastHeartbeatAt, claimedAt);
        const expiresAt = normalizeIsoDate(
          lease.expiresAt,
          new Date(Date.parse(lastHeartbeatAt) + ttlMinutes * 60_000).toISOString(),
        );
        const recovered: ClaimLeaseRecord = {
          target: normalizedTarget,
          owner,
          claimedAt,
          lastHeartbeatAt,
          expiresAt,
          ttlMinutes,
        };
        const changed = !recordEqual(lease, recovered);
        if (changed || target !== normalizedTarget) repaired += 1;
        if (target !== normalizedTarget) {
          delete state.leases[target];
        }
        state.leases[normalizedTarget] = recovered;
      }

      saveClaimLeaseState(safeWorkspacePath, state);
      return {
        inspected: Object.keys(state.leases).length,
        repaired,
        removed,
        issues,
      };
    }),
  );
}

function loadClaimLeaseState(workspacePath: string): ClaimLeaseState {
  const filePath = claimLeasePath(workspacePath);
  if (!fs.existsSync(filePath)) {
    return seedState();
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as ClaimLeaseState;
    if (parsed.version !== CLAIM_LEASE_VERSION || !parsed.leases || typeof parsed.leases !== 'object') {
      throw new StateCorruptionError('claim-lease state shape mismatch', {
        workspacePath,
        target: filePath,
      });
    }
    return {
      version: CLAIM_LEASE_VERSION,
      leases: normalizeLeaseRecordMap(parsed.leases),
    };
  } catch (error) {
    logClaimLeaseWarning('Failed to load claim lease state; falling back to seeded state.', error);
    return seedState();
  }
}

function saveClaimLeaseState(workspacePath: string, state: ClaimLeaseState): void {
  const filePath = claimLeasePath(workspacePath);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteFile(filePath, JSON.stringify(state, null, 2) + '\n');
}

function seedState(): ClaimLeaseState {
  return {
    version: CLAIM_LEASE_VERSION,
    leases: {},
  };
}

function normalizeTtlMinutes(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TTL_MINUTES;
  if (value < 0) return 0;
  if (value > 24 * 60) return 24 * 60;
  return value;
}

function normalizeIsoDate(value: unknown, fallback: string): string {
  const raw = String(value ?? '').trim();
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function normalizeLeaseRecordMap(rawLeases: Record<string, unknown>): Record<string, ClaimLeaseRecord> {
  const normalized: Record<string, ClaimLeaseRecord> = {};
  for (const [target, value] of Object.entries(rawLeases)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Partial<ClaimLeaseRecord>;
    const normalizedTarget = String(entry.target ?? target).trim();
    const owner = String(entry.owner ?? '').trim();
    if (!normalizedTarget || !owner) continue;
    const ttlMinutes = normalizeTtlMinutes(entry.ttlMinutes);
    const claimedAt = normalizeIsoDate(entry.claimedAt, new Date().toISOString());
    const lastHeartbeatAt = normalizeIsoDate(entry.lastHeartbeatAt, claimedAt);
    const expiresAt = normalizeIsoDate(
      entry.expiresAt,
      new Date(Date.parse(lastHeartbeatAt) + ttlMinutes * 60_000).toISOString(),
    );
    normalized[normalizedTarget] = {
      target: normalizedTarget,
      owner,
      claimedAt,
      lastHeartbeatAt,
      expiresAt,
      ttlMinutes,
    };
  }
  return normalized;
}

function recordEqual(left: ClaimLeaseRecord, right: ClaimLeaseRecord): boolean {
  return left.target === right.target
    && left.owner === right.owner
    && left.claimedAt === right.claimedAt
    && left.lastHeartbeatAt === right.lastHeartbeatAt
    && left.expiresAt === right.expiresAt
    && left.ttlMinutes === right.ttlMinutes;
}

function withClaimLeaseOperation<T>(
  operation: string,
  context: {
    workspacePath?: string;
    threadPath?: string;
    actor?: string;
  },
  fn: () => T,
): T {
  try {
    return fn();
  } catch (error) {
    throw asWorkgraphError(error, `Claim lease operation failed: ${operation}`, {
      operation,
      workspacePath: context.workspacePath,
      threadPath: context.threadPath,
      actor: context.actor,
    });
  }
}

function logClaimLeaseWarning(message: string, error: unknown): void {
  const rendered = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`[workgraph][warn][claim-lease] ${message} (${rendered})\n`);
}
