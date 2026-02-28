/**
 * Thread lifecycle operations.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as ledger from './ledger.js';
import * as store from './store.js';
import * as claimLease from './claim-lease.js';
import * as triggerEngine from './trigger-engine.js';
import type { PrimitiveInstance, ThreadStatus } from './types.js';
import { THREAD_STATUS_TRANSITIONS } from './types.js';

const CLAIM_LOCK_STALE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Thread creation
// ---------------------------------------------------------------------------

export function createThread(
  workspacePath: string,
  title: string,
  goal: string,
  actor: string,
  opts: {
    priority?: string;
    deps?: string[];
    parent?: string;
    space?: string;
    context_refs?: string[];
    tags?: string[];
  } = {},
): PrimitiveInstance {
  const normalizedSpace = opts.space ? normalizeWorkspaceRef(opts.space) : undefined;
  const contextRefs = opts.context_refs ?? [];
  const mergedContextRefs = normalizedSpace && !contextRefs.includes(normalizedSpace)
    ? [...contextRefs, normalizedSpace]
    : contextRefs;
  const inferredDeps = inferThreadDependenciesFromText(goal);
  const mergedDeps = uniqueThreadRefs([...(opts.deps ?? []), ...inferredDeps]);

  return store.create(workspacePath, 'thread', {
    title,
    goal,
    status: 'open',
    priority: opts.priority ?? 'medium',
    deps: mergedDeps,
    parent: opts.parent,
    space: normalizedSpace,
    context_refs: mergedContextRefs,
    tags: opts.tags ?? [],
  }, `## Goal\n\n${goal}\n`, actor);
}

// ---------------------------------------------------------------------------
// Agent-first scheduling helpers
// ---------------------------------------------------------------------------

export function isReadyForClaim(workspacePath: string, threadPathOrInstance: string | PrimitiveInstance): boolean {
  const instance = typeof threadPathOrInstance === 'string'
    ? store.read(workspacePath, threadPathOrInstance)
    : threadPathOrInstance;
  if (!instance) return false;
  if (instance.type !== 'thread') return false;
  if (instance.fields.status !== 'open') return false;

  // Parent threads should not be auto-scheduled while unfinished child threads exist.
  const hasUnfinishedChildren = store.list(workspacePath, 'thread').some((candidate) =>
    candidate.fields.parent === instance.path &&
    !['done', 'cancelled'].includes(String(candidate.fields.status))
  );
  if (hasUnfinishedChildren) return false;

  const deps = Array.isArray(instance.fields.deps) ? instance.fields.deps : [];
  if (deps.length === 0) return true;

  for (const dep of deps) {
    const depRef = normalizeThreadRef(dep);
    if (!depRef) continue;
    if (depRef.startsWith('external/')) return false;
    const depThread = store.read(workspacePath, depRef);
    if (!depThread || depThread.fields.status !== 'done') {
      return false;
    }
  }
  return true;
}

export function listReadyThreads(workspacePath: string): PrimitiveInstance[] {
  const open = store.openThreads(workspacePath);
  return open.filter(t => isReadyForClaim(workspacePath, t)).sort(compareThreadPriority);
}

export function listReadyThreadsInSpace(workspacePath: string, spaceRef: string): PrimitiveInstance[] {
  const normalizedSpace = normalizeWorkspaceRef(spaceRef);
  return listReadyThreads(workspacePath).filter((thread) =>
    normalizeWorkspaceRef(thread.fields.space) === normalizedSpace
  );
}

export function pickNextReadyThread(workspacePath: string): PrimitiveInstance | null {
  const ready = listReadyThreads(workspacePath);
  return ready[0] ?? null;
}

export function pickNextReadyThreadInSpace(workspacePath: string, spaceRef: string): PrimitiveInstance | null {
  const ready = listReadyThreadsInSpace(workspacePath, spaceRef);
  return ready[0] ?? null;
}

export function claimNextReady(workspacePath: string, actor: string): PrimitiveInstance | null {
  const next = pickNextReadyThread(workspacePath);
  if (!next) return null;
  return claim(workspacePath, next.path, actor);
}

export function claimNextReadyInSpace(workspacePath: string, actor: string, spaceRef: string): PrimitiveInstance | null {
  const next = pickNextReadyThreadInSpace(workspacePath, spaceRef);
  if (!next) return null;
  return claim(workspacePath, next.path, actor);
}

// ---------------------------------------------------------------------------
// Claim / Release
// ---------------------------------------------------------------------------

export function claim(
  workspacePath: string,
  threadPath: string,
  actor: string,
  options: { leaseTtlMinutes?: number } = {},
): PrimitiveInstance {
  return withThreadClaimLock(workspacePath, threadPath, () => {
    const thread = store.read(workspacePath, threadPath);
    if (!thread) throw new Error(`Thread not found: ${threadPath}`);

    const status = thread.fields.status as ThreadStatus;
    if (status !== 'open') {
      throw new Error(`Cannot claim thread in "${status}" state. Only "open" threads can be claimed.`);
    }

    const owner = ledger.currentOwner(workspacePath, threadPath);
    if (owner) {
      throw new Error(`Thread already claimed by "${owner}". Wait for release or use a different thread.`);
    }

    ledger.append(workspacePath, actor, 'claim', threadPath, 'thread');
    const claimed = store.update(workspacePath, threadPath, {
      status: 'active',
      owner: actor,
    }, undefined, actor);
    claimLease.setClaimLease(workspacePath, threadPath, actor, {
      ttlMinutes: options.leaseTtlMinutes,
    });
    return claimed;
  });
}

export function release(
  workspacePath: string,
  threadPath: string,
  actor: string,
  reason?: string,
): PrimitiveInstance {
  const thread = store.read(workspacePath, threadPath);
  if (!thread) throw new Error(`Thread not found: ${threadPath}`);

  assertOwner(workspacePath, threadPath, actor);

  ledger.append(workspacePath, actor, 'release', threadPath, 'thread',
    reason ? { reason } : undefined);

  const released = store.update(workspacePath, threadPath, {
    status: 'open',
    owner: null,
  }, undefined, actor);
  claimLease.removeClaimLease(workspacePath, threadPath);
  return released;
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

export function block(
  workspacePath: string,
  threadPath: string,
  actor: string,
  blockedBy: string,
  reason?: string,
): PrimitiveInstance {
  const thread = store.read(workspacePath, threadPath);
  if (!thread) throw new Error(`Thread not found: ${threadPath}`);

  assertTransition(thread.fields.status as ThreadStatus, 'blocked');

  ledger.append(workspacePath, actor, 'block', threadPath, 'thread', {
    blocked_by: blockedBy,
    ...(reason ? { reason } : {}),
  });

  const currentDeps = (thread.fields.deps as string[]) ?? [];
  const normalizedBlockedBy = normalizeThreadRef(blockedBy) || blockedBy;
  const updatedDeps = currentDeps.includes(normalizedBlockedBy)
    ? currentDeps
    : [...currentDeps, normalizedBlockedBy];

  return store.update(workspacePath, threadPath, {
    status: 'blocked',
    deps: updatedDeps,
  }, undefined, actor);
}

export function unblock(
  workspacePath: string,
  threadPath: string,
  actor: string,
): PrimitiveInstance {
  const thread = store.read(workspacePath, threadPath);
  if (!thread) throw new Error(`Thread not found: ${threadPath}`);

  assertTransition(thread.fields.status as ThreadStatus, 'active');

  ledger.append(workspacePath, actor, 'unblock', threadPath, 'thread');

  return store.update(workspacePath, threadPath, {
    status: 'active',
  }, undefined, actor);
}

export function done(
  workspacePath: string,
  threadPath: string,
  actor: string,
  output?: string,
): PrimitiveInstance {
  const thread = store.read(workspacePath, threadPath);
  if (!thread) throw new Error(`Thread not found: ${threadPath}`);

  assertTransition(thread.fields.status as ThreadStatus, 'done');
  assertOwner(workspacePath, threadPath, actor);

  ledger.append(workspacePath, actor, 'done', threadPath, 'thread',
    output ? { output } : undefined);

  const newBody = output
    ? `${thread.body}\n\n## Output\n\n${output}\n`
    : thread.body;

  const completed = store.update(workspacePath, threadPath, {
    status: 'done',
  }, newBody, actor);
  claimLease.removeClaimLease(workspacePath, threadPath);

  // Cascade trigger failures should not roll back a successful thread completion.
  try {
    triggerEngine.evaluateThreadCompleteCascadeTriggers(workspacePath, threadPath, actor);
  } catch {
    // No-op: trigger engine state captures per-trigger errors during cascade evaluation.
  }

  return completed;
}

export function cancel(
  workspacePath: string,
  threadPath: string,
  actor: string,
  reason?: string,
): PrimitiveInstance {
  const thread = store.read(workspacePath, threadPath);
  if (!thread) throw new Error(`Thread not found: ${threadPath}`);

  assertTransition(thread.fields.status as ThreadStatus, 'cancelled');

  ledger.append(workspacePath, actor, 'cancel', threadPath, 'thread',
    reason ? { reason } : undefined);

  const cancelled = store.update(workspacePath, threadPath, {
    status: 'cancelled',
    owner: null,
  }, undefined, actor);
  claimLease.removeClaimLease(workspacePath, threadPath);
  return cancelled;
}

export function reopen(
  workspacePath: string,
  threadPath: string,
  actor: string,
  reason?: string,
): PrimitiveInstance {
  const thread = store.read(workspacePath, threadPath);
  if (!thread) throw new Error(`Thread not found: ${threadPath}`);
  const status = String(thread.fields.status ?? '') as ThreadStatus;
  if (status !== 'done' && status !== 'cancelled') {
    throw new Error(`Cannot reopen thread in "${status}" state. Only done/cancelled threads can be reopened.`);
  }

  ledger.append(workspacePath, actor, 'reopen', threadPath, 'thread', reason ? { reason } : undefined);
  claimLease.removeClaimLease(workspacePath, threadPath);
  return store.update(workspacePath, threadPath, {
    status: 'open',
    owner: null,
  }, undefined, actor);
}

export interface ThreadHeartbeatResult {
  actor: string;
  touched: Array<{ threadPath: string; expiresAt: string; ttlMinutes: number }>;
  skipped: Array<{ threadPath: string; reason: string }>;
}

export function heartbeatClaim(
  workspacePath: string,
  actor: string,
  threadPath?: string,
  options: { ttlMinutes?: number } = {},
): ThreadHeartbeatResult {
  const targets = threadPath
    ? [threadPath]
    : store.list(workspacePath, 'thread')
      .filter((entry) => {
        const status = String(entry.fields.status ?? '');
        return (status === 'active' || status === 'blocked') && String(entry.fields.owner ?? '') === actor;
      })
      .map((entry) => entry.path);
  const touched: ThreadHeartbeatResult['touched'] = [];
  const skipped: ThreadHeartbeatResult['skipped'] = [];

  for (const target of targets) {
    const thread = store.read(workspacePath, target);
    if (!thread) {
      skipped.push({ threadPath: target, reason: 'not found' });
      continue;
    }
    const status = String(thread.fields.status ?? '');
    if (status !== 'active' && status !== 'blocked') {
      skipped.push({ threadPath: target, reason: `status=${status || 'unknown'}` });
      continue;
    }
    if (String(thread.fields.owner ?? '') !== actor) {
      skipped.push({ threadPath: target, reason: `owned by ${String(thread.fields.owner ?? 'unknown')}` });
      continue;
    }

    const lease = claimLease.setClaimLease(workspacePath, target, actor, {
      ttlMinutes: options.ttlMinutes,
    });
    ledger.append(workspacePath, actor, 'heartbeat', target, 'thread', {
      expires_at: lease.expiresAt,
      ttl_minutes: lease.ttlMinutes,
    });
    touched.push({
      threadPath: target,
      expiresAt: lease.expiresAt,
      ttlMinutes: lease.ttlMinutes,
    });
  }

  return { actor, touched, skipped };
}

export interface ReapStaleClaimsResult {
  actor: string;
  scanned: number;
  reaped: Array<{ threadPath: string; previousOwner: string; expiredAt: string }>;
  skipped: Array<{ threadPath: string; reason: string }>;
}

export function reapStaleClaims(
  workspacePath: string,
  actor: string,
  options: { limit?: number } = {},
): ReapStaleClaimsResult {
  const staleLeases = claimLease
    .listClaimLeases(workspacePath)
    .filter((lease) => lease.stale)
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  const max = options.limit && options.limit > 0 ? options.limit : Number.MAX_SAFE_INTEGER;
  const selected = staleLeases.slice(0, max);
  const reaped: ReapStaleClaimsResult['reaped'] = [];
  const skipped: ReapStaleClaimsResult['skipped'] = [];

  for (const lease of selected) {
    const thread = store.read(workspacePath, lease.target);
    if (!thread) {
      claimLease.removeClaimLease(workspacePath, lease.target);
      skipped.push({ threadPath: lease.target, reason: 'thread missing; lease removed' });
      continue;
    }
    const status = String(thread.fields.status ?? '');
    const owner = String(thread.fields.owner ?? '');
    if (status !== 'active' && status !== 'blocked') {
      claimLease.removeClaimLease(workspacePath, lease.target);
      skipped.push({ threadPath: lease.target, reason: `status=${status}; lease removed` });
      continue;
    }
    if (owner !== lease.owner) {
      claimLease.removeClaimLease(workspacePath, lease.target);
      skipped.push({
        threadPath: lease.target,
        reason: `owner mismatch (${owner} vs lease ${lease.owner}); lease removed`,
      });
      continue;
    }

    ledger.append(workspacePath, actor, 'release', lease.target, 'thread', {
      reason: 'lease-expired',
      lease_owner: lease.owner,
      expired_at: lease.expiresAt,
    });
    store.update(workspacePath, lease.target, {
      status: 'open',
      owner: null,
    }, undefined, actor);
    claimLease.removeClaimLease(workspacePath, lease.target);
    reaped.push({
      threadPath: lease.target,
      previousOwner: lease.owner,
      expiredAt: lease.expiresAt,
    });
  }

  return {
    actor,
    scanned: selected.length,
    reaped,
    skipped,
  };
}

export function listClaimLeaseStatus(workspacePath: string): claimLease.ClaimLeaseStatus[] {
  return claimLease.listClaimLeases(workspacePath);
}

// ---------------------------------------------------------------------------
// Decompose — break a thread into sub-threads
// ---------------------------------------------------------------------------

export function decompose(
  workspacePath: string,
  parentPath: string,
  subthreads: Array<{ title: string; goal: string; deps?: string[] }>,
  actor: string,
): PrimitiveInstance[] {
  const parent = store.read(workspacePath, parentPath);
  if (!parent) throw new Error(`Thread not found: ${parentPath}`);

  const created: PrimitiveInstance[] = [];

  for (const sub of subthreads) {
    const inst = createThread(workspacePath, sub.title, sub.goal, actor, {
      parent: parentPath,
      deps: sub.deps,
      space: typeof parent.fields.space === 'string' ? parent.fields.space : undefined,
    });
    created.push(inst);
  }

  const childRefs = created.map(c => `[[${c.path}]]`);
  const decomposeNote = `\n\n## Sub-threads\n\n${childRefs.map(r => `- ${r}`).join('\n')}\n`;

  store.update(workspacePath, parentPath, {}, parent.body + decomposeNote, actor);

  ledger.append(workspacePath, actor, 'decompose', parentPath, 'thread', {
    children: created.map(c => c.path),
  });

  return created;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertTransition(from: ThreadStatus, to: ThreadStatus): void {
  const allowed = THREAD_STATUS_TRANSITIONS[from];
  if (!allowed?.includes(to)) {
    throw new Error(`Invalid transition: "${from}" → "${to}". Allowed: ${allowed?.join(', ') ?? 'none'}`);
  }
}

function assertOwner(workspacePath: string, threadPath: string, actor: string): void {
  const owner = ledger.currentOwner(workspacePath, threadPath);
  if (owner && owner !== actor) {
    throw new Error(`Thread is owned by "${owner}", not "${actor}". Only the owner can perform this action.`);
  }
}

function compareThreadPriority(a: PrimitiveInstance, b: PrimitiveInstance): number {
  const rank = (value: unknown): number => {
    const normalized = String(value ?? 'medium').toLowerCase();
    switch (normalized) {
      case 'urgent': return 0;
      case 'high': return 1;
      case 'medium': return 2;
      case 'low': return 3;
      default: return 4;
    }
  };

  const byPriority = rank(a.fields.priority) - rank(b.fields.priority);
  if (byPriority !== 0) return byPriority;
  const createdA = Date.parse(String(a.fields.created ?? ''));
  const createdB = Date.parse(String(b.fields.created ?? ''));
  const safeA = Number.isNaN(createdA) ? Number.MAX_SAFE_INTEGER : createdA;
  const safeB = Number.isNaN(createdB) ? Number.MAX_SAFE_INTEGER : createdB;
  return safeA - safeB;
}

export function inferThreadDependenciesFromText(text: string): string[] {
  const refs = new Set<string>();
  const wikiMatches = text.matchAll(/\[\[([^[\]]+)\]\]/g);
  for (const match of wikiMatches) {
    const raw = match[1]?.split('|')[0]?.trim() ?? '';
    const normalized = normalizeThreadRef(raw);
    if (normalized && !normalized.startsWith('external/')) refs.add(normalized);
  }
  const pathMatches = text.matchAll(/\bthreads\/[a-z0-9._/-]+(?:\.md)?\b/gi);
  for (const match of pathMatches) {
    const normalized = normalizeThreadRef(match[0] ?? '');
    if (normalized && !normalized.startsWith('external/')) refs.add(normalized);
  }
  return [...refs].sort((a, b) => a.localeCompare(b));
}

function normalizeThreadRef(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  const primary = unwrapped.split('|')[0].trim().split('#')[0].trim();
  if (!primary) return '';
  if (primary.startsWith('external/')) return primary;
  if (primary.endsWith('.md')) return primary;
  return `${primary}.md`;
}

function normalizeWorkspaceRef(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  return unwrapped.endsWith('.md') ? unwrapped : `${unwrapped}.md`;
}

function uniqueThreadRefs(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeThreadRef(value);
    if (!normalized || normalized.startsWith('external/')) continue;
    seen.add(normalized);
  }
  return [...seen];
}

function withThreadClaimLock<T>(
  workspacePath: string,
  threadPath: string,
  fn: () => T,
): T {
  const lockDir = path.join(workspacePath, '.workgraph', 'locks');
  if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
  const lockName = `${crypto.createHash('sha1').update(threadPath).digest('hex')}.lock`;
  const lockPath = path.join(lockDir, lockName);
  const acquired = tryAcquireLock(lockPath, threadPath);
  if (!acquired) {
    throw new Error(`Thread "${threadPath}" is currently being claimed by another worker. Retry shortly.`);
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

function tryAcquireLock(lockPath: string, target: string): boolean {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      target,
      createdAt: new Date().toISOString(),
    }) + '\n', 'utf-8');
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if (!isAlreadyExistsError(error)) return false;
    if (isStaleLock(lockPath)) {
      fs.rmSync(lockPath, { force: true });
      return tryAcquireLock(lockPath, target);
    }
    return false;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return 'code' in error && (error as { code?: string }).code === 'EEXIST';
}

function isStaleLock(lockPath: string): boolean {
  if (!fs.existsSync(lockPath)) return false;
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as { createdAt?: string };
    if (!parsed.createdAt) return true;
    const createdAt = Date.parse(parsed.createdAt);
    if (!Number.isFinite(createdAt)) return true;
    return Date.now() - createdAt >= CLAIM_LOCK_STALE_MS;
  } catch {
    return true;
  }
}
