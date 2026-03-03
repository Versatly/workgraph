import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import * as ledger from './ledger.js';
import * as registry from './registry.js';
import { reconcile } from './reconciler.js';
import * as store from './store.js';
import * as thread from './thread.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-reconciler-'));
  registry.saveRegistry(workspacePath, registry.loadRegistry(workspacePath));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('board reconciler', () => {
  it('returns ok=true for a compliant workspace', () => {
    const task = thread.createThread(workspacePath, 'Compliant task', 'do compliant work', 'agent-a');
    thread.claim(workspacePath, task.path, 'agent-a');
    thread.done(workspacePath, task.path, 'agent-a', 'proof https://github.com/versatly/workgraph/pull/61');

    const report = reconcile(workspacePath);
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('detects missing T-ID violations', () => {
    store.create(workspacePath, 'thread', {
      title: 'Legacy thread',
      goal: 'legacy goal',
      status: 'open',
      priority: 'medium',
      deps: [],
      context_refs: [],
      tags: [],
      terminalLock: true,
    }, '# Legacy', 'agent-a', { pathOverride: 'threads/legacy-thread.md' });

    const report = reconcile(workspacePath);
    expect(report.ok).toBe(false);
    expect(report.violations.some((entry) => entry.code === 'missing_tid')).toBe(true);
  });

  it('flags orphan thread ledger entries', () => {
    ledger.append(workspacePath, 'agent-a', 'claim', 'threads/missing-thread.md', 'thread');

    const report = reconcile(workspacePath);
    expect(report.ok).toBe(false);
    expect(report.violations.some((entry) => entry.code === 'orphan_ledger_entry')).toBe(true);
  });

  it('reports evidence policy violations for done threads with missing evidence', () => {
    const task = thread.createThread(workspacePath, 'Manual done mismatch', 'manual done', 'agent-a');
    thread.claim(workspacePath, task.path, 'agent-a');
    ledger.append(workspacePath, 'agent-a', 'done', task.path, 'thread');
    store.update(workspacePath, task.path, { status: 'done' }, undefined, 'agent-a');

    const report = reconcile(workspacePath);
    expect(report.violations.some((entry) => entry.code === 'evidence_policy_violation')).toBe(true);
  });

  it('reports dependency gate violations for done parents with open descendants', () => {
    const parent = thread.createThread(workspacePath, 'Done parent with open child', 'parent goal', 'agent-a');
    thread.decompose(workspacePath, parent.path, [{ title: 'Open child', goal: 'child goal' }], 'agent-a');
    ledger.append(workspacePath, 'agent-a', 'done', parent.path, 'thread', {
      evidence_policy: 'strict',
      evidence: [{ type: 'url', value: 'https://github.com/versatly/workgraph/pull/62' }],
    });
    store.update(workspacePath, parent.path, { status: 'done' }, undefined, 'agent-a');

    const report = reconcile(workspacePath);
    expect(report.violations.some((entry) => entry.code === 'dependency_gate_violation')).toBe(true);
  });

  it('reports terminal lock violations when non-reopen ops follow done', () => {
    const task = thread.createThread(workspacePath, 'Terminal lock break', 'lock break', 'agent-a');
    thread.claim(workspacePath, task.path, 'agent-a');
    thread.done(workspacePath, task.path, 'agent-a', 'proof https://github.com/versatly/workgraph/pull/63');
    ledger.append(workspacePath, 'agent-a', 'block', task.path, 'thread', { blocked_by: 'external/dep' });

    const report = reconcile(workspacePath);
    expect(report.violations.some((entry) => entry.code === 'terminal_lock_violation')).toBe(true);
  });

  it('reports reopen entries missing required reason', () => {
    const task = thread.createThread(workspacePath, 'Missing reopen reason', 'reopen reason', 'agent-a');
    thread.claim(workspacePath, task.path, 'agent-a');
    thread.done(workspacePath, task.path, 'agent-a', 'proof https://github.com/versatly/workgraph/pull/64');
    ledger.append(workspacePath, 'agent-a', 'reopen', task.path, 'thread');

    const report = reconcile(workspacePath);
    expect(report.violations.some((entry) => entry.code === 'reopen_missing_reason')).toBe(true);
  });

  it('detects status mismatches without supporting ledger transitions', () => {
    const task = thread.createThread(workspacePath, 'Manual status mutate', 'manual mutate', 'agent-a');
    const absPath = path.join(workspacePath, task.path);
    const parsed = matter(fs.readFileSync(absPath, 'utf-8'));
    const frontmatter = parsed.data as Record<string, unknown>;
    frontmatter.status = 'blocked';
    fs.writeFileSync(absPath, matter.stringify(parsed.content, frontmatter), 'utf-8');

    const report = reconcile(workspacePath);
    expect(report.violations.some((entry) => entry.code === 'status_transition_missing_ledger')).toBe(true);
  });

  it('emits warning when tid does not match file slug', () => {
    store.create(workspacePath, 'thread', {
      tid: 'custom-tid',
      title: 'Path mismatch thread',
      goal: 'goal',
      status: 'open',
      priority: 'medium',
      deps: [],
      context_refs: [],
      tags: [],
      terminalLock: true,
    }, '# Mismatch', 'agent-a', { pathOverride: 'threads/different-slug.md' });

    const report = reconcile(workspacePath);
    expect(report.warnings.some((entry) => entry.code === 'tid_path_mismatch')).toBe(true);
  });
});
