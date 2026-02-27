/**
 * Thread lifecycle operations.
 */

import * as ledger from './ledger.js';
import * as store from './store.js';
import type { PrimitiveInstance, ThreadStatus } from './types.js';
import { THREAD_STATUS_TRANSITIONS } from './types.js';

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

  return store.create(workspacePath, 'thread', {
    title,
    goal,
    status: 'open',
    priority: opts.priority ?? 'medium',
    deps: opts.deps ?? [],
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
): PrimitiveInstance {
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

  return store.update(workspacePath, threadPath, {
    status: 'active',
    owner: actor,
  }, undefined, actor);
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

  return store.update(workspacePath, threadPath, {
    status: 'open',
    owner: null,
  }, undefined, actor);
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
  const updatedDeps = currentDeps.includes(blockedBy) ? currentDeps : [...currentDeps, blockedBy];

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

  return store.update(workspacePath, threadPath, {
    status: 'done',
  }, newBody, actor);
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

  return store.update(workspacePath, threadPath, {
    status: 'cancelled',
    owner: null,
  }, undefined, actor);
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

function normalizeThreadRef(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return raw;
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  if (unwrapped.startsWith('external/')) return unwrapped;
  if (unwrapped.endsWith('.md')) return unwrapped;
  return `${unwrapped}.md`;
}

function normalizeWorkspaceRef(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  return unwrapped.endsWith('.md') ? unwrapped : `${unwrapped}.md`;
}
