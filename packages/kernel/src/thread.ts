/**
 * Thread lifecycle operations.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as ledger from './ledger.js';
import * as store from './store.js';
import * as auth from './auth.js';
import * as claimLease from './claim-lease.js';
import * as triggerEngine from './trigger-engine.js';
import * as gate from './gate.js';
import { collectThreadEvidence, validateThreadEvidence } from './evidence.js';
import type {
  PrimitiveInstance,
  ThreadDoneOptions,
  ThreadParticipant,
  ThreadParticipantRole,
  ThreadStatus,
} from './types.js';
import { THREAD_STATUS_TRANSITIONS } from './types.js';

const CLAIM_LOCK_STALE_MS = 5 * 60_000;
const THREAD_PARTICIPANT_PERMISSIONS: Record<ThreadParticipantRole, ReadonlySet<ThreadParticipantPermission>> = {
  owner: new Set(['participants:manage', 'thread:claim', 'thread:mutate', 'thread:complete']),
  contributor: new Set(['thread:claim', 'thread:mutate', 'thread:complete']),
  reviewer: new Set(['thread:claim', 'thread:complete']),
  observer: new Set([]),
};

type ThreadParticipantPermission =
  | 'participants:manage'
  | 'thread:claim'
  | 'thread:mutate'
  | 'thread:complete';

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
  assertThreadMutationAuthorized(workspacePath, actor, 'thread.create', 'threads', [
    'thread:create',
    'thread:manage',
    'policy:manage',
  ]);
  const normalizedSpace = opts.space ? normalizeWorkspaceRef(opts.space) : undefined;
  const contextRefs = opts.context_refs ?? [];
  const mergedContextRefs = normalizedSpace && !contextRefs.includes(normalizedSpace)
    ? [...contextRefs, normalizedSpace]
    : contextRefs;
  const inferredDeps = inferThreadDependenciesFromText(goal);
  const mergedDeps = uniqueThreadRefs([...(opts.deps ?? []), ...inferredDeps]);
  const tid = mintThreadId(title);
  const participants = [createThreadParticipantRecord(actor, 'owner')];

  return store.create(workspacePath, 'thread', {
    tid,
    title,
    goal,
    status: 'open',
    priority: opts.priority ?? 'medium',
    deps: mergedDeps,
    parent: opts.parent,
    space: normalizedSpace,
    context_refs: mergedContextRefs,
    participants,
    tags: opts.tags ?? [],
  }, `## Goal\n\n${goal}\n`, actor, {
    skipAuthorization: true,
    action: 'thread.create.store',
    requiredCapabilities: ['thread:create', 'thread:manage', 'policy:manage'],
  });
}

export function mintThreadId(title: string): string {
  const normalized = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || 'thread';
}

export function listThreadParticipants(workspacePath: string, threadPath: string): ThreadParticipant[] {
  const thread = store.read(workspacePath, threadPath);
  if (!thread) throw new Error(`Thread not found: ${threadPath}`);
  return normalizeThreadParticipants(thread.fields.participants);
}

export function joinThread(
  workspacePath: string,
  threadPath: string,
  actor: string,
  role: ThreadParticipantRole = 'contributor',
): PrimitiveInstance {
  assertThreadMutationAuthorized(workspacePath, actor, 'thread.join', threadPath, [
    'thread:update',
    'thread:manage',
  ]);
  const thread = store.read(workspacePath, threadPath);
  if (!thread) throw new Error(`Thread not found: ${threadPath}`);
  assertThreadNotTerminallyLocked(workspacePath, thread, actor, 'join');
  const normalizedRole = normalizeThreadParticipantRole(role);
  if (normalizedRole === 'owner') {
    throw new Error('Join cannot grant owner role. Use invite with an owner participant.');
  }

  const participants = normalizeThreadParticipants(thread.fields.participants);
  const actorId = normalizeParticipantActor(actor);
  if (!actorId) {
    throw new Error('Join requires a non-empty actor.');
  }
  if (findThreadParticipant(participants, actorId)) {
    return thread;
  }

  const nextParticipants = [...participants, createThreadParticipantRecord(actorId, normalizedRole, actor)];
  return updateThreadParticipants(
    workspacePath,
    threadPath,
    nextParticipants,
    actor,
    'thread.join.store',
    ['thread:update', 'thread:manage'],
  );
}

export function inviteThreadParticipant(
  workspacePath: string,
  threadPath: string,
  actor: string,
  participantActor: string,
  role: ThreadParticipantRole = 'contributor',
): PrimitiveInstance {
  assertThreadMutationAuthorized(workspacePath, actor, 'thread.invite', threadPath, [
    'thread:update',
    'thread:manage',
  ]);
  const thread = store.read(workspacePath, threadPath);
  if (!thread) throw new Error(`Thread not found: ${threadPath}`);
  assertThreadNotTerminallyLocked(workspacePath, thread, actor, 'invite');
  assertThreadParticipantPermission(thread, actor, 'participants:manage');

  const normalizedTarget = normalizeParticipantActor(participantActor);
  if (!normalizedTarget) {
    throw new Error('Invite requires a non-empty participant actor.');
  }
  const normalizedRole = normalizeThreadParticipantRole(role);
  const participants = normalizeThreadParticipants(thread.fields.participants);
  const existing = findThreadParticipant(participants, normalizedTarget);
  const nextParticipants = existing
    ? participants.map((entry) => entry.actor === normalizedTarget
      ? {
          ...entry,
          role: normalizedRole,
          invited_by: normalizeParticipantActor(actor),
        }
      : entry)
    : [...participants, createThreadParticipantRecord(normalizedTarget, normalizedRole, actor)];
  assertAtLeastOneOwner(nextParticipants);
  return updateThreadParticipants(
    workspacePath,
    threadPath,
    nextParticipants,
    actor,
    'thread.invite.store',
    ['thread:update', 'thread:manage'],
  );
}

export function leaveThread(
  workspacePath: string,
  threadPath: string,
  actor: string,
  participantActor?: string,
): PrimitiveInstance {
  assertThreadMutationAuthorized(workspacePath, actor, 'thread.leave', threadPath, [
    'thread:update',
    'thread:manage',
  ]);
  const thread = store.read(workspacePath, threadPath);
  if (!thread) throw new Error(`Thread not found: ${threadPath}`);
  assertThreadNotTerminallyLocked(workspacePath, thread, actor, 'leave');

  const participants = normalizeThreadParticipants(thread.fields.participants);
  const actorId = normalizeParticipantActor(actor);
  const targetActor = normalizeParticipantActor(participantActor ?? actor);
  if (!targetActor) {
    throw new Error('Leave requires a non-empty actor.');
  }
  if (targetActor !== actorId) {
    assertThreadParticipantPermission(thread, actor, 'participants:manage');
  }
  if (isThreadActivelyOwnedBy(thread, targetActor)) {
    throw new Error(`Cannot remove "${targetActor}" while actively owning "${threadPath}". Release or handoff first.`);
  }
  const nextParticipants = participants.filter((entry) => entry.actor !== targetActor);
  if (nextParticipants.length === participants.length) {
    return thread;
  }
  assertAtLeastOneOwner(nextParticipants);
  return updateThreadParticipants(
    workspacePath,
    threadPath,
    nextParticipants,
    actor,
    'thread.leave.store',
    ['thread:update', 'thread:manage'],
  );
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
  assertThreadMutationAuthorized(workspacePath, actor, 'thread.claim', threadPath, [
    'thread:claim',
    'thread:manage',
  ]);
  return withThreadClaimLock(workspacePath, threadPath, () => {
    const thread = store.read(workspacePath, threadPath);
    if (!thread) throw new Error(`Thread not found: ${threadPath}`);
    assertThreadNotTerminallyLocked(workspacePath, thread, actor, 'claim');
    assertThreadParticipantPermission(thread, actor, 'thread:claim', { allowImplicitJoinForClaim: true });
    const gateCheck = gate.checkThreadGates(workspacePath, threadPath);
    if (!gateCheck.allowed) {
      throw new Error(gate.summarizeGateFailures(gateCheck));
    }

    const status = thread.fields.status as ThreadStatus;
    if (status !== 'open') {
      throw new Error(`Cannot claim thread in "${status}" state. Only "open" threads can be claimed.`);
    }

    const owner = ledger.currentOwner(workspacePath, threadPath);
    if (owner) {
      throw new Error(`Thread already claimed by "${owner}". Wait for release or use a different thread.`);
    }

    const participants = normalizeThreadParticipants(thread.fields.participants);
    const participantEntry = findThreadParticipant(participants, actor);
    const nextParticipants = participantEntry
      ? participants
      : [
          ...participants,
          createThreadParticipantRecord(
            actor,
            participants.length === 0 ? 'owner' : 'contributor',
            actor,
          ),
        ];

    ledger.append(workspacePath, actor, 'claim', threadPath, 'thread');
    const claimed = store.update(workspacePath, threadPath, {
      status: 'active',
      owner: actor,
      ...(nextParticipants.length !== participants.length ? { participants: nextParticipants } : {}),
    }, undefined, actor, {
      skipAuthorization: true,
      action: 'thread.claim.store',
      requiredCapabilities: ['thread:claim', 'thread:manage'],
    });
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
  assertThreadMutationAuthorized(workspacePath, actor, 'thread.release', threadPath, [
    'thread:update',
    'thread:manage',
  ]);
  const thread = store.read(workspacePath, threadPath);
  if (!thread) throw new Error(`Thread not found: ${threadPath}`);
  assertThreadNotTerminallyLocked(workspacePath, thread, actor, 'release');
  assertThreadParticipantPermission(thread, actor, 'thread:mutate');

  assertOwner(workspacePath, threadPath, actor);

  ledger.append(workspacePath, actor, 'release', threadPath, 'thread',
    reason ? { reason } : undefined);

  const released = store.update(workspacePath, threadPath, {
    status: 'open',
    owner: null,
  }, undefined, actor, {
    skipAuthorization: true,
    action: 'thread.release.store',
    requiredCapabilities: ['thread:update', 'thread:manage'],
  });
  claimLease.removeClaimLease(workspacePath, threadPath);
  return released;
}

export function heartbeat(
  workspacePath: string,
  threadPath: string,
  actor: string,
  leaseMinutes: number = 15,
): PrimitiveInstance {
  assertThreadMutationAuthorized(workspacePath, actor, 'thread.heartbeat', threadPath, [
    'thread:update',
    'thread:manage',
  ]);
  const thread = store.read(workspacePath, threadPath);
  if (!thread) throw new Error(`Thread not found: ${threadPath}`);
  assertThreadNotTerminallyLocked(workspacePath, thread, actor, 'heartbeat');
  assertThreadParticipantPermission(thread, actor, 'thread:mutate');
  if (thread.fields.status !== 'active') {
    throw new Error(`Cannot heartbeat thread in "${String(thread.fields.status)}" state. Only active threads can be heartbeated.`);
  }
  const owner = ledger.currentOwner(workspacePath, threadPath);
  if (owner !== actor) {
    throw new Error(`Thread heartbeat denied: "${threadPath}" is owned by "${owner ?? 'nobody'}", not "${actor}".`);
  }

  const safeLeaseMinutes = Number.isFinite(leaseMinutes) && leaseMinutes > 0
    ? Math.floor(leaseMinutes)
    : 15;
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + safeLeaseMinutes * 60_000).toISOString();
  ledger.append(workspacePath, actor, 'update', threadPath, 'thread', {
    heartbeat: true,
    lease_minutes: safeLeaseMinutes,
    lease_until: leaseUntil,
  });
  return store.update(
    workspacePath,
    threadPath,
    {
      last_heartbeat_at: now.toISOString(),
      claim_lease_until: leaseUntil,
    },
    undefined,
    actor,
    {
      skipAuthorization: true,
      action: 'thread.heartbeat.store',
      requiredCapabilities: ['thread:update', 'thread:manage'],
    },
  );
}

export function handoff(
  workspacePath: string,
  threadPath: string,
  fromActor: string,
  toActor: string,
  note?: string,
): PrimitiveInstance {
  assertThreadMutationAuthorized(workspacePath, fromActor, 'thread.handoff', threadPath, [
    'thread:update',
    'thread:manage',
  ]);
  const normalizedToActor = toActor.trim();
  if (!normalizedToActor) {
    throw new Error('Handoff target actor must be a non-empty string.');
  }

  const existing = store.read(workspacePath, threadPath);
  if (!existing) throw new Error(`Thread not found: ${threadPath}`);
  assertThreadNotTerminallyLocked(workspacePath, existing, fromActor, 'handoff');
  assertThreadParticipantPermission(existing, fromActor, 'thread:mutate');
  if (existing.fields.status !== 'active') {
    throw new Error(`Cannot handoff thread in "${String(existing.fields.status)}" state. Only active threads can be handed off.`);
  }
  assertOwner(workspacePath, threadPath, fromActor);

  const handoffReason = note?.trim()
    ? `handoff to ${normalizedToActor}: ${note.trim()}`
    : `handoff to ${normalizedToActor}`;
  release(workspacePath, threadPath, fromActor, handoffReason);
  const claimed = claim(workspacePath, threadPath, normalizedToActor);
  const now = new Date().toISOString();

  const extraBody = note?.trim()
    ? `${claimed.body}\n\n## Handoff\n\nTransferred from ${fromActor} to ${normalizedToActor} at ${now}.\n\n${note.trim()}\n`
    : claimed.body;
  return store.update(
    workspacePath,
    threadPath,
    {
      handoff_from: fromActor,
      handoff_to: normalizedToActor,
      last_handoff_at: now,
      claim_lease_until: undefined,
    },
    extraBody,
    fromActor,
    {
      skipAuthorization: true,
      action: 'thread.handoff.store',
      requiredCapabilities: ['thread:update', 'thread:manage'],
    },
  );
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
  assertThreadMutationAuthorized(workspacePath, actor, 'thread.block', threadPath, [
    'thread:update',
    'thread:manage',
  ]);
  const thread = store.read(workspacePath, threadPath);
  if (!thread) throw new Error(`Thread not found: ${threadPath}`);
  assertThreadNotTerminallyLocked(workspacePath, thread, actor, 'block');
  assertThreadParticipantPermission(thread, actor, 'thread:mutate');

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
  }, undefined, actor, {
    skipAuthorization: true,
    action: 'thread.block.store',
    requiredCapabilities: ['thread:update', 'thread:manage'],
  });
}

export function unblock(
  workspacePath: string,
  threadPath: string,
  actor: string,
): PrimitiveInstance {
  assertThreadMutationAuthorized(workspacePath, actor, 'thread.unblock', threadPath, [
    'thread:update',
    'thread:manage',
  ]);
  const thread = store.read(workspacePath, threadPath);
  if (!thread) throw new Error(`Thread not found: ${threadPath}`);
  assertThreadNotTerminallyLocked(workspacePath, thread, actor, 'unblock');
  assertThreadParticipantPermission(thread, actor, 'thread:mutate');

  assertTransition(thread.fields.status as ThreadStatus, 'active');

  ledger.append(workspacePath, actor, 'unblock', threadPath, 'thread');

  return store.update(workspacePath, threadPath, {
    status: 'active',
  }, undefined, actor, {
    skipAuthorization: true,
    action: 'thread.unblock.store',
    requiredCapabilities: ['thread:update', 'thread:manage'],
  });
}

export function done(
  workspacePath: string,
  threadPath: string,
  actor: string,
  output?: string,
  options: ThreadDoneOptions = {},
): PrimitiveInstance {
  assertThreadMutationAuthorized(workspacePath, actor, 'thread.done', threadPath, [
    'thread:complete',
    'thread:manage',
  ]);
  const thread = store.read(workspacePath, threadPath);
  if (!thread) throw new Error(`Thread not found: ${threadPath}`);
  assertThreadNotTerminallyLocked(workspacePath, thread, actor, 'done');
  assertThreadParticipantPermission(thread, actor, 'thread:complete');
  const gateCheck = gate.checkThreadGates(workspacePath, threadPath);
  if (!gateCheck.allowed) {
    throw new Error(gate.summarizeGateFailures(gateCheck));
  }

  const descendantCheck = gate.checkRequiredDescendants(workspacePath, threadPath);
  if (!descendantCheck.ok) {
    throw new Error(`Cannot mark ${threadPath} done. ${descendantCheck.message}`);
  }

  assertTransition(thread.fields.status as ThreadStatus, 'done');
  assertOwner(workspacePath, threadPath, actor);

  const evidencePolicy = gate.resolveThreadEvidencePolicy(workspacePath, thread);
  const evidence = collectThreadEvidence(output, options.evidence ?? []);
  const evidenceResult = validateThreadEvidence(evidence, evidencePolicy);
  if (!evidenceResult.ok) {
    throw new Error(renderEvidenceError(threadPath, evidenceResult));
  }

  ledger.append(workspacePath, actor, 'done', threadPath, 'thread',
    {
      ...(output ? { output } : {}),
      evidence_policy: evidencePolicy,
      evidence: evidenceResult.evidence.map((entry) => ({
        type: entry.type,
        value: entry.value,
        valid: entry.valid,
        ...(entry.reason ? { reason: entry.reason } : {}),
      })),
    });

  const newBody = output
    ? `${thread.body}\n\n## Output\n\n${output}\n`
    : thread.body;

  const completed = store.update(workspacePath, threadPath, {
    status: 'done',
  }, newBody, actor, {
    skipAuthorization: true,
    action: 'thread.done.store',
    requiredCapabilities: ['thread:complete', 'thread:manage'],
  });
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
  assertThreadMutationAuthorized(workspacePath, actor, 'thread.cancel', threadPath, [
    'thread:update',
    'thread:manage',
  ]);
  const thread = store.read(workspacePath, threadPath);
  if (!thread) throw new Error(`Thread not found: ${threadPath}`);
  assertThreadNotTerminallyLocked(workspacePath, thread, actor, 'cancel');
  assertThreadParticipantPermission(thread, actor, 'thread:mutate');

  assertTransition(thread.fields.status as ThreadStatus, 'cancelled');

  ledger.append(workspacePath, actor, 'cancel', threadPath, 'thread',
    reason ? { reason } : undefined);

  const cancelled = store.update(workspacePath, threadPath, {
    status: 'cancelled',
    owner: null,
  }, undefined, actor, {
    skipAuthorization: true,
    action: 'thread.cancel.store',
    requiredCapabilities: ['thread:update', 'thread:manage'],
  });
  claimLease.removeClaimLease(workspacePath, threadPath);
  return cancelled;
}

export function reopen(
  workspacePath: string,
  threadPath: string,
  actor: string,
  reason?: string,
): PrimitiveInstance {
  assertThreadMutationAuthorized(workspacePath, actor, 'thread.reopen', threadPath, [
    'thread:update',
    'thread:manage',
  ]);
  const thread = store.read(workspacePath, threadPath);
  if (!thread) throw new Error(`Thread not found: ${threadPath}`);
  assertThreadParticipantPermission(thread, actor, 'thread:complete');
  const status = String(thread.fields.status ?? '') as ThreadStatus;
  if (status !== 'done' && status !== 'cancelled') {
    throw new Error(`Cannot reopen thread in "${status}" state. Only done/cancelled threads can be reopened.`);
  }
  if (status === 'done' && !String(reason ?? '').trim()) {
    throw new Error('Reopen requires a reason when reopening a done thread.');
  }

  ledger.append(workspacePath, actor, 'reopen', threadPath, 'thread', reason ? { reason } : undefined);
  claimLease.removeClaimLease(workspacePath, threadPath);
  return store.update(workspacePath, threadPath, {
    status: 'open',
    owner: null,
  }, undefined, actor, {
    skipAuthorization: true,
    action: 'thread.reopen.store',
    requiredCapabilities: ['thread:update', 'thread:manage'],
  });
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
  assertThreadMutationAuthorized(workspacePath, actor, 'thread.heartbeat-claim', threadPath ?? 'threads', [
    'thread:update',
    'thread:manage',
  ]);
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
    try {
      assertThreadParticipantPermission(thread, actor, 'thread:mutate');
    } catch (error) {
      skipped.push({
        threadPath: target,
        reason: error instanceof Error ? error.message : 'participant permission denied',
      });
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
  assertThreadMutationAuthorized(workspacePath, actor, 'thread.reap-stale-claims', '.workgraph/claim-leases', [
    'thread:manage',
    'policy:manage',
  ]);
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
    }, undefined, actor, {
      skipAuthorization: true,
      action: 'thread.reap-stale.store',
      requiredCapabilities: ['thread:manage', 'policy:manage'],
    });
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

export interface ThreadStateRecoveryResult {
  repairedAt: string;
  leaseState: claimLease.ClaimLeaseRecoveryResult;
  staleClaims: ReapStaleClaimsResult;
  brokenReferences: Array<{
    threadPath: string;
    removedDeps: string[];
    clearedParent?: string;
  }>;
}

export function recoverThreadState(
  workspacePath: string,
  actor: string,
  options: { staleClaimLimit?: number } = {},
): ThreadStateRecoveryResult {
  assertThreadMutationAuthorized(workspacePath, actor, 'thread.recover-state', '.workgraph', [
    'thread:manage',
    'policy:manage',
  ]);
  const leaseState = claimLease.recoverClaimLeaseState(workspacePath);
  const staleClaims = reapStaleClaims(workspacePath, actor, {
    limit: options.staleClaimLimit,
  });
  const threads = store.list(workspacePath, 'thread');
  const existing = new Set(threads.map((entry) => entry.path));
  const brokenReferences: ThreadStateRecoveryResult['brokenReferences'] = [];
  for (const threadInstance of threads) {
    const deps = Array.isArray(threadInstance.fields.deps)
      ? threadInstance.fields.deps.map((value) => String(value))
      : [];
    const removedDeps = deps
      .map((dep) => normalizeThreadRef(dep))
      .filter((dep) => dep && !dep.startsWith('external/') && !existing.has(dep));
    const parentRef = normalizeThreadRef(threadInstance.fields.parent);
    const shouldClearParent = Boolean(parentRef && !parentRef.startsWith('external/') && !existing.has(parentRef));
    if (removedDeps.length === 0 && !shouldClearParent) continue;
    const removedDepSet = new Set(removedDeps);
    const nextDeps = deps.filter((dep) => {
      const normalized = normalizeThreadRef(dep);
      if (!normalized || normalized.startsWith('external/')) return true;
      return !removedDepSet.has(normalized);
    });
    store.update(
      workspacePath,
      threadInstance.path,
      {
        deps: nextDeps,
        ...(shouldClearParent ? { parent: undefined } : {}),
      },
      undefined,
      actor,
      {
        skipAuthorization: true,
        action: 'thread.recover-state.store',
        requiredCapabilities: ['thread:manage', 'policy:manage'],
      },
    );
    ledger.append(workspacePath, actor, 'update', threadInstance.path, 'thread', {
      recovered: true,
      removed_broken_deps: removedDeps,
      ...(shouldClearParent ? { cleared_parent: parentRef } : {}),
    });
    brokenReferences.push({
      threadPath: threadInstance.path,
      removedDeps,
      ...(shouldClearParent ? { clearedParent: parentRef } : {}),
    });
  }
  return {
    repairedAt: new Date().toISOString(),
    leaseState,
    staleClaims,
    brokenReferences,
  };
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
  assertThreadMutationAuthorized(workspacePath, actor, 'thread.decompose', parentPath, [
    'thread:update',
    'thread:manage',
  ]);
  const parent = store.read(workspacePath, parentPath);
  if (!parent) throw new Error(`Thread not found: ${parentPath}`);
  assertThreadParticipantPermission(parent, actor, 'thread:mutate');

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

  store.update(workspacePath, parentPath, {}, parent.body + decomposeNote, actor, {
    skipAuthorization: true,
    action: 'thread.decompose.store',
    requiredCapabilities: ['thread:update', 'thread:manage'],
  });

  ledger.append(workspacePath, actor, 'decompose', parentPath, 'thread', {
    children: created.map(c => c.path),
  });

  return created;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertThreadNotTerminallyLocked(
  workspacePath: string,
  thread: PrimitiveInstance,
  actor: string,
  attemptedOp:
    | 'claim'
    | 'release'
    | 'heartbeat'
    | 'handoff'
    | 'block'
    | 'unblock'
    | 'done'
    | 'cancel'
    | 'join'
    | 'leave'
    | 'invite',
): void {
  const status = String(thread.fields.status ?? '');
  const terminalLock = asBoolean(thread.fields.terminalLock, true);
  if (status !== 'done' || !terminalLock) return;

  const reason = `Thread "${thread.path}" is terminally locked after done. Use reopen with a reason to continue changes.`;
  ledger.append(workspacePath, actor, 'rejected', thread.path, 'thread', {
    attempted_op: attemptedOp,
    reason,
    locked_status: status,
  });
  throw new Error(reason);
}

function assertThreadParticipantPermission(
  thread: PrimitiveInstance,
  actor: string,
  permission: ThreadParticipantPermission,
  options: { allowImplicitJoinForClaim?: boolean } = {},
): void {
  const participants = normalizeThreadParticipants(thread.fields.participants);
  if (participants.length === 0) return;
  const actorId = normalizeParticipantActor(actor);
  const participant = findThreadParticipant(participants, actorId);
  if (!participant) {
    if (permission === 'thread:claim' && options.allowImplicitJoinForClaim) return;
    throw new Error(`Thread permission denied: "${actor}" is not a participant on ${thread.path}.`);
  }
  const allowed = THREAD_PARTICIPANT_PERMISSIONS[participant.role];
  if (!allowed.has(permission)) {
    throw new Error(
      `Thread permission denied: role "${participant.role}" cannot perform "${renderParticipantPermission(permission)}".`,
    );
  }
}

function renderParticipantPermission(permission: ThreadParticipantPermission): string {
  switch (permission) {
    case 'participants:manage':
      return 'participant management';
    case 'thread:claim':
      return 'thread claims';
    case 'thread:mutate':
      return 'thread lifecycle mutations';
    case 'thread:complete':
      return 'thread completion mutations';
    default:
      return permission;
  }
}

function updateThreadParticipants(
  workspacePath: string,
  threadPath: string,
  participants: ThreadParticipant[],
  actor: string,
  action: string,
  requiredCapabilities: string[],
): PrimitiveInstance {
  const normalizedParticipants = normalizeThreadParticipants(participants);
  return store.update(
    workspacePath,
    threadPath,
    {
      participants: normalizedParticipants,
    },
    undefined,
    actor,
    {
      skipAuthorization: true,
      action,
      requiredCapabilities,
    },
  );
}

function createThreadParticipantRecord(
  actor: string,
  role: ThreadParticipantRole,
  invitedBy?: string,
): ThreadParticipant {
  return {
    actor: normalizeParticipantActor(actor),
    role: normalizeThreadParticipantRole(role),
    joined_at: new Date().toISOString(),
    ...(normalizeParticipantActor(invitedBy) ? { invited_by: normalizeParticipantActor(invitedBy) } : {}),
  };
}

function normalizeThreadParticipants(value: unknown): ThreadParticipant[] {
  if (!Array.isArray(value)) return [];
  const deduped = new Map<string, ThreadParticipant>();
  for (const rawEntry of value) {
    const entry = normalizeThreadParticipant(rawEntry);
    if (!entry) continue;
    deduped.set(entry.actor, entry);
  }
  return [...deduped.values()].sort((a, b) => a.actor.localeCompare(b.actor));
}

function normalizeThreadParticipant(value: unknown): ThreadParticipant | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<ThreadParticipant> & { joinedAt?: string; invitedBy?: string };
  const actor = normalizeParticipantActor(record.actor);
  if (!actor) return null;
  let role: ThreadParticipantRole;
  try {
    role = normalizeThreadParticipantRole(record.role);
  } catch {
    return null;
  }
  const joinedAtCandidate = normalizeIso(record.joined_at) ?? normalizeIso(record.joinedAt);
  const joinedAt = joinedAtCandidate ?? '1970-01-01T00:00:00.000Z';
  const invitedBy = normalizeParticipantActor(record.invited_by ?? record.invitedBy);
  return {
    actor,
    role,
    joined_at: joinedAt,
    ...(invitedBy ? { invited_by: invitedBy } : {}),
  };
}

function normalizeThreadParticipantRole(value: unknown): ThreadParticipantRole {
  const normalized = String(value ?? 'contributor').trim().toLowerCase();
  if (
    normalized === 'owner' ||
    normalized === 'contributor' ||
    normalized === 'reviewer' ||
    normalized === 'observer'
  ) {
    return normalized;
  }
  throw new Error(
    `Invalid thread participant role "${String(value ?? '')}". Expected owner|contributor|reviewer|observer.`,
  );
}

function findThreadParticipant(
  participants: ThreadParticipant[],
  actor: string,
): ThreadParticipant | undefined {
  const actorId = normalizeParticipantActor(actor);
  return participants.find((entry) => entry.actor === actorId);
}

function assertAtLeastOneOwner(participants: ThreadParticipant[]): void {
  if (participants.length === 0) {
    throw new Error('Thread participants must retain at least one owner.');
  }
  if (participants.some((participant) => participant.role === 'owner')) return;
  throw new Error('Thread participants must retain at least one owner.');
}

function isThreadActivelyOwnedBy(thread: PrimitiveInstance, actor: string): boolean {
  const owner = normalizeParticipantActor(thread.fields.owner);
  const actorId = normalizeParticipantActor(actor);
  const status = String(thread.fields.status ?? '');
  return owner === actorId && (status === 'active' || status === 'blocked');
}

function normalizeParticipantActor(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function normalizeIso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

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

function renderEvidenceError(
  threadPath: string,
  result: ReturnType<typeof validateThreadEvidence>,
): string {
  if (result.policy === 'none') {
    return '';
  }
  if (result.validEvidence.length === 0) {
    return `Cannot mark ${threadPath} done: at least one valid evidence item is required (policy=${result.policy}).`;
  }
  const reasons = result.invalidEvidence.map((entry) => `${entry.type}:${entry.value} (${entry.reason ?? 'invalid'})`);
  return `Cannot mark ${threadPath} done: invalid evidence detected (${reasons.join('; ')}).`;
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

function asBoolean(value: unknown, fallback: boolean = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return fallback;
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

function assertThreadMutationAuthorized(
  workspacePath: string,
  actor: string,
  action: string,
  target: string,
  requiredCapabilities: string[],
): void {
  auth.assertAuthorizedMutation(workspacePath, {
    actor,
    action,
    target,
    requiredCapabilities,
    metadata: {
      module: 'thread',
    },
  });
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
