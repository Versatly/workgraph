import * as ledger from './ledger.js';
import * as store from './store.js';
import { listClaimLeases } from './claim-lease.js';

export type ThreadAuditIssueKind =
  | 'thread_without_ledger_history'
  | 'active_without_claim'
  | 'active_owner_mismatch'
  | 'claim_without_active_status'
  | 'owner_set_without_active'
  | 'dependency_reference_not_declared'
  | 'declared_dependency_missing_target'
  | 'active_without_lease'
  | 'stale_lease';

export interface ThreadAuditIssue {
  kind: ThreadAuditIssueKind;
  path: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ThreadAuditReport {
  ok: boolean;
  generatedAt: string;
  totalThreads: number;
  totalClaims: number;
  totalLeases: number;
  issues: ThreadAuditIssue[];
}

export function reconcileThreadState(workspacePath: string): ThreadAuditReport {
  const generatedAt = new Date().toISOString();
  const threads = store.list(workspacePath, 'thread');
  const claims = ledger.allClaims(workspacePath);
  const leases = listClaimLeases(workspacePath);
  const leaseByTarget = new Map(leases.map((lease) => [lease.target, lease]));
  const issues: ThreadAuditIssue[] = [];

  for (const thread of threads) {
    const status = String(thread.fields.status ?? '');
    const owner = normalizeString(thread.fields.owner);
    const claimOwner = claims.get(thread.path);
    const history = ledger.historyOf(workspacePath, thread.path);
    const deps = normalizeStringList(thread.fields.deps);
    const referencedDeps = extractThreadReferences(thread.body);

    if (history.length === 0) {
      issues.push({
        kind: 'thread_without_ledger_history',
        path: thread.path,
        message: 'Thread has no ledger history.',
      });
    }

    if ((status === 'active' || status === 'blocked') && !claimOwner) {
      issues.push({
        kind: 'active_without_claim',
        path: thread.path,
        message: `Thread is ${status} with owner "${owner ?? 'none'}" but ledger has no active claim.`,
      });
    }

    if ((status === 'active' || status === 'blocked') && claimOwner && owner && claimOwner !== owner) {
      issues.push({
        kind: 'active_owner_mismatch',
        path: thread.path,
        message: `Thread owner "${owner}" does not match ledger claim owner "${claimOwner}".`,
      });
    }

    if (claimOwner && status !== 'active' && status !== 'blocked') {
      issues.push({
        kind: 'claim_without_active_status',
        path: thread.path,
        message: `Ledger claim owner "${claimOwner}" exists while thread status is "${status}".`,
      });
    }

    if (owner && status !== 'active' && status !== 'blocked') {
      issues.push({
        kind: 'owner_set_without_active',
        path: thread.path,
        message: `Thread owner "${owner}" is set while status is "${status}".`,
      });
    }

    const undeclaredRefs = referencedDeps.filter((dep) => !deps.includes(dep));
    if (undeclaredRefs.length > 0) {
      issues.push({
        kind: 'dependency_reference_not_declared',
        path: thread.path,
        message: `Thread body references dependencies not listed in deps: ${undeclaredRefs.join(', ')}`,
        details: {
          referenced: referencedDeps,
          declared: deps,
        },
      });
    }

    const missingTargets = deps.filter((dep) => !store.read(workspacePath, dep));
    if (missingTargets.length > 0) {
      issues.push({
        kind: 'declared_dependency_missing_target',
        path: thread.path,
        message: `Thread deps contains missing targets: ${missingTargets.join(', ')}`,
      });
    }

    if (status === 'active' || status === 'blocked') {
      const lease = leaseByTarget.get(thread.path);
      if (!lease) {
        issues.push({
          kind: 'active_without_lease',
          path: thread.path,
          message: `Thread is ${status} but has no claim lease/heartbeat record.`,
        });
      } else if (lease.stale) {
        issues.push({
          kind: 'stale_lease',
          path: thread.path,
          message: `Thread lease is stale (expired at ${lease.expiresAt}).`,
          details: {
            owner: lease.owner,
            expiresAt: lease.expiresAt,
            lastHeartbeatAt: lease.lastHeartbeatAt,
          },
        });
      }
    }
  }

  for (const [target, owner] of claims.entries()) {
    const thread = store.read(workspacePath, target);
    if (!thread) {
      issues.push({
        kind: 'claim_without_active_status',
        path: target,
        message: `Ledger claim owner "${owner}" references a missing thread target.`,
      });
      continue;
    }
    if (thread.type !== 'thread') {
      issues.push({
        kind: 'claim_without_active_status',
        path: target,
        message: `Ledger claim owner "${owner}" references non-thread primitive type "${thread.type}".`,
      });
    }
  }

  return {
    ok: issues.length === 0,
    generatedAt,
    totalThreads: threads.length,
    totalClaims: claims.size,
    totalLeases: leases.length,
    issues,
  };
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeThreadRef(String(entry ?? '')))
    .filter((entry): entry is string => !!entry);
}

function extractThreadReferences(body: string): string[] {
  const refs = new Set<string>();
  const wikilinks = body.matchAll(/\[\[([^[\]]+)\]\]/g);
  for (const match of wikilinks) {
    const raw = match[1]?.split('|')[0]?.trim() ?? '';
    const normalized = normalizeThreadRef(raw);
    if (normalized) refs.add(normalized);
  }
  const pathRefs = body.matchAll(/\bthreads\/[a-z0-9._/-]+(?:\.md)?\b/gi);
  for (const match of pathRefs) {
    const normalized = normalizeThreadRef(match[0] ?? '');
    if (normalized) refs.add(normalized);
  }
  return [...refs].sort((a, b) => a.localeCompare(b));
}

function normalizeThreadRef(value: string): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const noAnchor = raw.split('#')[0].trim();
  if (!noAnchor.toLowerCase().startsWith('threads/')) return null;
  return noAnchor.endsWith('.md') ? noAnchor : `${noAnchor}.md`;
}
