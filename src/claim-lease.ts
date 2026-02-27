import fs from 'node:fs';
import path from 'node:path';

const CLAIM_LEASE_FILE = '.workgraph/claim-leases.json';
const CLAIM_LEASE_VERSION = 1;
const DEFAULT_TTL_MINUTES = 30;

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

export function listClaimLeases(
  workspacePath: string,
  nowMs: number = Date.now(),
): ClaimLeaseStatus[] {
  const state = loadClaimLeaseState(workspacePath);
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
  const state = loadClaimLeaseState(workspacePath);
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const ttlMinutes = normalizeTtlMinutes(options.ttlMinutes);
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
  const record: ClaimLeaseRecord = {
    target,
    owner,
    claimedAt: options.claimedAt ?? state.leases[target]?.claimedAt ?? nowIso,
    lastHeartbeatAt: nowIso,
    expiresAt,
    ttlMinutes,
  };
  state.leases[target] = record;
  saveClaimLeaseState(workspacePath, state);
  return record;
}

export function removeClaimLease(workspacePath: string, target: string): void {
  const state = loadClaimLeaseState(workspacePath);
  if (!state.leases[target]) return;
  delete state.leases[target];
  saveClaimLeaseState(workspacePath, state);
}

export function claimLeasePath(workspacePath: string): string {
  return path.join(workspacePath, CLAIM_LEASE_FILE);
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
      return seedState();
    }
    return parsed;
  } catch {
    return seedState();
  }
}

function saveClaimLeaseState(workspacePath: string, state: ClaimLeaseState): void {
  const filePath = claimLeasePath(workspacePath);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
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
