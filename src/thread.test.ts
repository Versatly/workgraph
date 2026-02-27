import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createThread,
  claim,
  release,
  block,
  unblock,
  done,
  cancel,
  decompose,
  isReadyForClaim,
  listReadyThreads,
  listReadyThreadsInSpace,
  pickNextReadyThread,
  pickNextReadyThreadInSpace,
  claimNextReady,
  claimNextReadyInSpace,
} from './thread.js';
import { loadRegistry, saveRegistry } from './registry.js';
import * as ledger from './ledger.js';
import * as store from './store.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-thread-'));
  const reg = loadRegistry(workspacePath);
  saveRegistry(workspacePath, reg);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('thread lifecycle', () => {
  it('creates a thread in open state', () => {
    const t = createThread(workspacePath, 'Build Auth', 'Implement JWT', 'agent-a');
    expect(t.fields.status).toBe('open');
    expect(t.fields.owner).toBeUndefined();
    expect(t.path).toBe('threads/build-auth.md');
  });

  it('supports space-scoped thread creation', () => {
    const t = createThread(workspacePath, 'Space Task', 'Do work in space', 'agent-a', {
      space: 'spaces/backend',
    });
    expect(t.fields.space).toBe('spaces/backend.md');
    expect(t.fields.context_refs).toContain('spaces/backend.md');
  });

  it('claim sets status to active and records owner', () => {
    createThread(workspacePath, 'Claimable', 'test', 'agent-a');
    const claimed = claim(workspacePath, 'threads/claimable.md', 'agent-b');

    expect(claimed.fields.status).toBe('active');
    expect(claimed.fields.owner).toBe('agent-b');
    expect(ledger.currentOwner(workspacePath, 'threads/claimable.md')).toBe('agent-b');
  });

  it('prevents double claiming', () => {
    createThread(workspacePath, 'Contested', 'test', 'agent-a');
    claim(workspacePath, 'threads/contested.md', 'agent-b');

    expect(() => claim(workspacePath, 'threads/contested.md', 'agent-c'))
      .toThrow('Cannot claim thread in "active" state');
  });

  it('release returns thread to open state', () => {
    createThread(workspacePath, 'Releasable', 'test', 'agent-a');
    claim(workspacePath, 'threads/releasable.md', 'agent-b');
    const released = release(workspacePath, 'threads/releasable.md', 'agent-b', 'need more info');

    expect(released.fields.status).toBe('open');
    expect(released.fields.owner).toBeNull();
    expect(ledger.isClaimed(workspacePath, 'threads/releasable.md')).toBe(false);
  });

  it('release by non-owner fails', () => {
    createThread(workspacePath, 'Owned', 'test', 'agent-a');
    claim(workspacePath, 'threads/owned.md', 'agent-b');

    expect(() => release(workspacePath, 'threads/owned.md', 'agent-c'))
      .toThrow('owned by "agent-b"');
  });

  it('block sets status and adds dependency', () => {
    createThread(workspacePath, 'Blockable', 'test', 'agent-a');
    claim(workspacePath, 'threads/blockable.md', 'agent-a');
    const blocked = block(workspacePath, 'threads/blockable.md', 'agent-a', 'threads/dep.md', 'waiting for schema');

    expect(blocked.fields.status).toBe('blocked');
    expect(blocked.fields.deps).toContain('threads/dep.md');
  });

  it('unblock returns to active', () => {
    createThread(workspacePath, 'Unblockable', 'test', 'agent-a');
    claim(workspacePath, 'threads/unblockable.md', 'agent-a');
    block(workspacePath, 'threads/unblockable.md', 'agent-a', 'threads/dep.md');
    const unblocked = unblock(workspacePath, 'threads/unblockable.md', 'agent-a');

    expect(unblocked.fields.status).toBe('active');
  });

  it('done marks thread complete and appends output', () => {
    createThread(workspacePath, 'Completable', 'test', 'agent-a');
    claim(workspacePath, 'threads/completable.md', 'agent-a');
    const completed = done(workspacePath, 'threads/completable.md', 'agent-a', 'Auth system shipped');

    expect(completed.fields.status).toBe('done');
    expect(completed.body).toContain('Auth system shipped');
    expect(ledger.isClaimed(workspacePath, 'threads/completable.md')).toBe(false);
  });

  it('done by non-owner fails', () => {
    createThread(workspacePath, 'NotYours', 'test', 'agent-a');
    claim(workspacePath, 'threads/notyours.md', 'agent-a');

    expect(() => done(workspacePath, 'threads/notyours.md', 'agent-b'))
      .toThrow('owned by "agent-a"');
  });

  it('cancel stops a thread', () => {
    createThread(workspacePath, 'Cancellable', 'test', 'agent-a');
    const cancelled = cancel(workspacePath, 'threads/cancellable.md', 'agent-a', 'no longer needed');

    expect(cancelled.fields.status).toBe('cancelled');
  });

  it('decompose creates sub-threads with parent ref', () => {
    createThread(workspacePath, 'Big Task', 'do everything', 'agent-a', {
      space: 'spaces/backend.md',
    });

    const children = decompose(workspacePath, 'threads/big-task.md', [
      { title: 'Sub A', goal: 'do A' },
      { title: 'Sub B', goal: 'do B', deps: ['threads/sub-a.md'] },
    ], 'agent-a');

    expect(children).toHaveLength(2);
    expect(children[0].fields.parent).toBe('threads/big-task.md');
    expect(children[1].fields.deps).toContain('threads/sub-a.md');
    expect(children[0].fields.space).toBe('spaces/backend.md');
    expect(children[1].fields.space).toBe('spaces/backend.md');

    const parent = store.read(workspacePath, 'threads/big-task.md');
    expect(parent!.body).toContain('Sub-threads');
    expect(parent!.body).toContain('sub-a.md');
    expect(parent!.body).toContain('sub-b.md');

    const decompEntries = ledger.readAll(workspacePath).filter(e => e.op === 'decompose');
    expect(decompEntries).toHaveLength(1);
    expect(decompEntries[0].data?.children).toHaveLength(2);
  });

  it('full lifecycle: create → claim → block → unblock → done', () => {
    createThread(workspacePath, 'Full Cycle', 'test lifecycle', 'agent-a');
    claim(workspacePath, 'threads/full-cycle.md', 'agent-b');
    block(workspacePath, 'threads/full-cycle.md', 'agent-b', 'threads/dep.md');
    unblock(workspacePath, 'threads/full-cycle.md', 'agent-b');
    done(workspacePath, 'threads/full-cycle.md', 'agent-b', 'All done');

    const t = store.read(workspacePath, 'threads/full-cycle.md');
    expect(t!.fields.status).toBe('done');

    const history = ledger.historyOf(workspacePath, 'threads/full-cycle.md');
    const ops = history.map(e => e.op);
    expect(ops).toContain('create');
    expect(ops).toContain('claim');
    expect(ops).toContain('block');
    expect(ops).toContain('unblock');
    expect(ops).toContain('done');
  });

  it('another agent can claim after release', () => {
    createThread(workspacePath, 'Handoff', 'test handoff', 'agent-a');
    claim(workspacePath, 'threads/handoff.md', 'agent-a');
    release(workspacePath, 'threads/handoff.md', 'agent-a');
    const reclaimed = claim(workspacePath, 'threads/handoff.md', 'agent-b');

    expect(reclaimed.fields.status).toBe('active');
    expect(reclaimed.fields.owner).toBe('agent-b');
  });

  it('invalid state transitions are rejected', () => {
    createThread(workspacePath, 'Bad Transition', 'test', 'agent-a');
    claim(workspacePath, 'threads/bad-transition.md', 'agent-a');
    done(workspacePath, 'threads/bad-transition.md', 'agent-a');

    expect(() => claim(workspacePath, 'threads/bad-transition.md', 'agent-b'))
      .toThrow('Cannot claim thread in "done" state');
  });
});

describe('thread scheduling helpers', () => {
  it('excludes decomposed parent threads until children are finished', () => {
    createThread(workspacePath, 'Parent initiative', 'Top-level goal', 'agent-a');
    decompose(workspacePath, 'threads/parent-initiative.md', [
      { title: 'Child A', goal: 'First child goal' },
      { title: 'Child B', goal: 'Second child goal' },
    ], 'agent-a');

    expect(isReadyForClaim(workspacePath, 'threads/parent-initiative.md')).toBe(false);
    expect(isReadyForClaim(workspacePath, 'threads/child-a.md')).toBe(true);
    expect(isReadyForClaim(workspacePath, 'threads/child-b.md')).toBe(true);

    const next = pickNextReadyThread(workspacePath);
    expect(next?.path).toBe('threads/child-a.md');
  });

  it('marks thread with unfinished deps as not ready', () => {
    createThread(workspacePath, 'Dependency', 'Complete dependency', 'agent-a');
    createThread(workspacePath, 'Blocked task', 'Waits on dep', 'agent-a', {
      deps: ['threads/dependency.md'],
    });
    expect(isReadyForClaim(workspacePath, 'threads/blocked-task.md')).toBe(false);
  });

  it('marks thread with completed deps as ready', () => {
    createThread(workspacePath, 'Dependency', 'Complete dependency', 'agent-a');
    claim(workspacePath, 'threads/dependency.md', 'agent-a');
    done(workspacePath, 'threads/dependency.md', 'agent-a', 'done');
    createThread(workspacePath, 'Blocked task', 'Waits on dep', 'agent-a', {
      deps: ['threads/dependency.md'],
    });
    expect(isReadyForClaim(workspacePath, 'threads/blocked-task.md')).toBe(true);
  });

  it('next ready prefers higher priority and can auto-claim', () => {
    createThread(workspacePath, 'Medium task', 'default', 'agent-a', { priority: 'medium' });
    createThread(workspacePath, 'High task', 'important', 'agent-a', { priority: 'high' });
    createThread(workspacePath, 'Low task', 'later', 'agent-a', { priority: 'low' });

    const ready = listReadyThreads(workspacePath);
    expect(ready.map(t => String(t.fields.title))).toEqual(['High task', 'Medium task', 'Low task']);

    const next = pickNextReadyThread(workspacePath);
    expect(next?.path).toBe('threads/high-task.md');

    const claimed = claimNextReady(workspacePath, 'agent-worker');
    expect(claimed?.path).toBe('threads/high-task.md');
    expect(claimed?.fields.owner).toBe('agent-worker');
  });

  it('supports space-scoped ready thread selection', () => {
    createThread(workspacePath, 'Backend task', 'backend', 'agent-a', { space: 'spaces/backend.md', priority: 'high' });
    createThread(workspacePath, 'Frontend task', 'frontend', 'agent-a', { space: 'spaces/frontend.md', priority: 'high' });
    createThread(workspacePath, 'No-space task', 'none', 'agent-a', { priority: 'urgent' });

    const backendReady = listReadyThreadsInSpace(workspacePath, 'spaces/backend');
    expect(backendReady).toHaveLength(1);
    expect(backendReady[0].path).toBe('threads/backend-task.md');

    const backendNext = pickNextReadyThreadInSpace(workspacePath, 'spaces/backend');
    expect(backendNext?.path).toBe('threads/backend-task.md');

    const claimed = claimNextReadyInSpace(workspacePath, 'agent-worker', 'spaces/backend');
    expect(claimed?.path).toBe('threads/backend-task.md');
    expect(claimed?.fields.owner).toBe('agent-worker');
  });
});
